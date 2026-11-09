//! Ce qu'un agent laisse derrière lui.
//!
//! Arrêter un agent, c'était tuer son CLI, et lui seul. Un `pnpm dev` qu'il
//! avait lancé en arrière-plan par son outil Bash ne mourait pas avec lui :
//! macOS le rattachait à launchd, et il continuait de tenir son port, de
//! recompiler et de grossir — trois jours durant, sur un poste relevé, pour
//! des workspaces refermés depuis. La fenêtre « mémoire saturée » de macOS
//! les range sous l'app qui les a lancés : c'est le cockpit qu'elle accusait,
//! à 27, puis 32, puis 37 Go.
//!
//! Relever l'arbre au moment d'arrêter ne suffit pas, comme pour les
//! terminaux (`terminal::reap`) : un serveur rattaché à launchd n'est déjà plus
//! dans la descendance de l'agent, et un agent qui s'est terminé de lui-même
//! n'a plus de descendance du tout. Ce qui survit à tout, en revanche, c'est
//! l'environnement : chaque agent naît avec `COCKPIT_AGENT_SESSION`, et tout ce
//! qu'il engendre en hérite, même ce qui s'est créé sa propre session. C'est
//! par là qu'on les retrouve.

use std::collections::HashMap;

const MARKER: &str = "COCKPIT_AGENT_SESSION=";

/// Un processus qui porte la marque d'un agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Marked {
	pub pid: u32,
	pub ppid: u32,
	pub rss_kb: u64,
	pub session: String,
}

/// Tous les processus de la machine, et parmi eux ceux qui portent une marque.
pub struct Table {
	/// Parent et exécutable de chaque processus : de quoi remonter une lignée.
	pub parents: HashMap<u32, (u32, String)>,
	pub marked: Vec<Marked>,
}

/// Une seule commande `ps`, environnement compris.
///
/// `ps -E` n'affiche l'environnement que des processus de l'utilisateur, ce
/// qui est exactement le périmètre voulu : le cockpit ne lance rien d'autre.
#[cfg(target_os = "macos")]
pub fn read() -> Table {
	let output =
		crate::platform::quiet_std(std::process::Command::new("ps").args(["-axwwE", "-o", "pid=,ppid=,rss=,command="]))
			.output();
	match output {
		Ok(output) => parse(&String::from_utf8_lossy(&output.stdout)),
		Err(_) => Table {
			parents: HashMap::new(),
			marked: Vec::new(),
		},
	}
}

/// Sous Windows, pas de `ps -E` : l'environnement d'un autre processus ne se
/// lit qu'en allant le chercher dans sa mémoire (`platform::process_environment`).
///
/// Choix pesé contre deux autres voies. La ligne de commande (WMI,
/// `Win32_Process`) ne porte pas la marque : un `pnpm dev` lancé par l'agent
/// n'a aucune raison de la répéter dans ses arguments. Un registre des pid
/// lancés par le cockpit ne connaîtrait que les racines, pas ce qu'elles
/// engendrent — précisément ce qu'on cherche. L'environnement, lui, est hérité
/// par toute la descendance, comme sous macOS. Seuls les processus du compte
/// s'ouvrent en lecture : même périmètre que `ps -E`.
///
/// Linux prend la même voie : `ps` n'y a pas d'option pour l'environnement,
/// et `/proc/<pid>/environ` le donne directement (`platform::process_environment`).
#[cfg(any(windows, target_os = "linux"))]
pub fn read() -> Table {
	let mut parents = HashMap::new();
	let mut marked = Vec::new();
	for process in crate::platform::processes() {
		parents.insert(process.pid, (process.ppid, process.name.clone()));
		let Some(environment) = crate::platform::process_environment(process.pid) else {
			continue;
		};
		// Les noms de variables ne distinguent pas la casse sous Windows.
		let session = environment.iter().find_map(|variable| {
			let (name, value) = variable.split_once('=')?;
			name.eq_ignore_ascii_case(MARKER.trim_end_matches('='))
				.then(|| value.trim().to_string())
		});
		if let Some(session) = session.filter(|session| !session.is_empty()) {
			marked.push(Marked {
				pid: process.pid,
				ppid: process.ppid,
				rss_kb: process.rss_kb,
				session,
			});
		}
	}
	Table { parents, marked }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse(raw: &str) -> Table {
	// Une variable peut contenir un saut de ligne — `COCKPIT_SCOPE` en sépare
	// ses chemins — et `ps` l'imprime tel quel. Une ligne qui ne commence pas
	// par trois nombres continue donc la précédente plutôt qu'elle ne s'ajoute.
	let mut records: Vec<String> = Vec::new();
	for line in raw.lines() {
		let mut fields = line.split_whitespace();
		let starts_a_record = (0..3).all(|_| {
			fields
				.next()
				.is_some_and(|field| field.bytes().all(|b| b.is_ascii_digit()))
		});
		match records.last_mut() {
			Some(last) if !starts_a_record => {
				last.push(' ');
				last.push_str(line);
			}
			_ => records.push(line.to_string()),
		}
	}

	let mut parents = HashMap::new();
	let mut marked = Vec::new();
	for record in records {
		let mut fields = record.split_whitespace();
		let (Some(pid), Some(ppid), Some(rss)) = (fields.next(), fields.next(), fields.next()) else {
			continue;
		};
		let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
			continue;
		};
		let executable = fields.next().unwrap_or_default();
		let name = executable.rsplit('/').next().unwrap_or(executable).to_string();
		parents.insert(pid, (ppid, name));

		// Précédée d'une espace : un argument qui contiendrait la chaîne en son
		// milieu — un `grep` sur la variable — ne passe pas pour une marque.
		if let Some(at) = record.find(&format!(" {MARKER}")) {
			let value = &record[at + 1 + MARKER.len()..];
			let session = value.split_whitespace().next().unwrap_or_default();
			if !session.is_empty() {
				marked.push(Marked {
					pid,
					ppid,
					rss_kb: rss.parse().unwrap_or(0),
					session: session.to_string(),
				});
			}
		}
	}
	Table { parents, marked }
}

impl Marked {
	/// Rattaché à la racine : son parent est mort. Sous macOS, launchd (pid 1)
	/// l'a adopté ; Windows n'adopte personne, et `platform::processes` met
	/// alors le parent à 0.
	pub fn detached(&self) -> bool {
		if cfg!(windows) {
			self.ppid == 0
		} else {
			self.ppid == 1
		}
	}
}

/// Le nom de l'exécutable du cockpit (`cockpit`, `Cockpit` sous Windows selon
/// l'installation).
fn is_cockpit(name: &str) -> bool {
	if cfg!(windows) {
		name.eq_ignore_ascii_case("cockpit")
	} else {
		name == "cockpit"
	}
}

impl Table {
	/// Vrai si un cockpit vivant figure parmi les ancêtres de ce processus.
	///
	/// C'est ce qui distingue l'agent d'un autre cockpit ouvert en même temps —
	/// une version de développement à côté de l'app installée — d'un reste
	/// rattaché à launchd.
	fn under_a_cockpit(&self, pid: u32) -> bool {
		let mut current = pid;
		for _ in 0..64 {
			let Some((ppid, _)) = self.parents.get(&current) else {
				return false;
			};
			if *ppid <= 1 {
				return false;
			}
			if self.parents.get(ppid).is_some_and(|(_, name)| is_cockpit(name)) {
				return true;
			}
			current = *ppid;
		}
		false
	}
}

/// Les processus d'un agent, hors le cockpit lui-même.
fn of_session(table: &Table, session: &str) -> Vec<u32> {
	let me = std::process::id();
	table
		.marked
		.iter()
		.filter(|marked| marked.session == session && marked.pid != me)
		.map(|marked| marked.pid)
		.collect()
}

/// Ce qui reste d'un démarrage précédent : marqué, sans cockpit au-dessus, et
/// sans relais vivant pour le réclamer.
fn left_behind(table: &Table, living_relays: &[String]) -> Vec<u32> {
	let me = std::process::id();
	table
		.marked
		.iter()
		.filter(|marked| marked.pid != me)
		.filter(|marked| !living_relays.contains(&marked.session))
		.filter(|marked| !table.under_a_cockpit(marked.pid))
		.map(|marked| marked.pid)
		.collect()
}

fn signal(signal: &str, pids: &[u32]) {
	for pid in pids {
		if signal == "-KILL" {
			crate::platform::kill_pid(*pid);
		} else {
			crate::platform::terminate_pid(*pid);
		}
	}
}

/// `SIGTERM` à tout ce qui porte ces marques, puis `SIGKILL` à ce qui tient
/// encore cinq secondes plus tard — un `next dev` en pleine compilation peut
/// ne pas répondre au premier.
///
/// La seconde frappe relit la table : entre-temps, un pid libéré a pu être
/// redonné à un tout autre processus, qui ne porterait pas la marque.
fn terminate(pids: Vec<u32>, sessions: Vec<String>) -> usize {
	let count = pids.len();
	signal("-TERM", &pids);
	if count > 0 {
		std::thread::spawn(move || {
			std::thread::sleep(std::time::Duration::from_secs(5));
			let table = read();
			let survivors: Vec<u32> = table
				.marked
				.iter()
				.filter(|marked| pids.contains(&marked.pid) && sessions.contains(&marked.session))
				.map(|marked| marked.pid)
				.collect();
			signal("-KILL", &survivors);
		});
	}
	count
}

/// Arrête tout ce qu'un agent a lancé, où que ce soit maintenant rattaché.
pub fn kill_session(session: &str) -> usize {
	let pids = of_session(&read(), session);
	terminate(pids, vec![session.to_string()])
}

/// Au démarrage : ce que le cockpit précédent n'a pas su arrêter.
///
/// Un cockpit tué net (plantage, `kill -9`, mise à jour interrompue) ne passe
/// pas par `agent::stop_all` ; et même quand il y passe, un serveur qui s'est
/// détaché de son agent avant la fermeture lui échappait. Les agents détachés
/// (`relay.rs`) sont épargnés : ils n'ont pas de cockpit au-dessus d'eux, par
/// conception.
pub fn sweep() -> usize {
	let living: Vec<String> = crate::relay::scan()
		.0
		.into_iter()
		.map(|found| found.meta.session_id)
		.collect();
	let table = read();
	let pids = left_behind(&table, &living);
	let sessions = table.marked.iter().map(|marked| marked.session.clone()).collect();
	terminate(pids, sessions)
}

#[cfg(test)]
mod tests {
	use super::*;

	const SAMPLE: &str = "\
    1     0  9000 /sbin/launchd
  500     1 90000 /Applications/Cockpit.app/Contents/MacOS/cockpit __CFBundleIdentifier=com.cockpit.app
  510   500  3000 /bin/zsh -lc claude COCKPIT_AGENT_SESSION=agent-vivant COCKPIT_SCOPE=src
docs
  511   510 200000 /Users/x/.local/bin/claude -p COCKPIT_SCOPE= COCKPIT_AGENT_SESSION=agent-vivant
  600     1 50000 node /opt/homebrew/bin/pnpm dev COCKPIT_AGENT_SESSION=agent-parti
  601   600 900000 node next-server COCKPIT_AGENT_SESSION=agent-parti
  700     1  4000 /bin/zsh -c tail -f in.jsonl COCKPIT_AGENT_SESSION=agent-detache
  800     1  1000 grep xCOCKPIT_AGENT_SESSION=leurre
";

	#[test]
	fn une_variable_sur_deux_lignes_ne_cree_pas_de_processus() {
		let table = parse(SAMPLE);
		assert_eq!(table.parents.len(), 8);
		assert!(table.marked.iter().any(|m| m.pid == 510 && m.session == "agent-vivant"));
	}

	#[test]
	fn une_marque_au_milieu_d_un_mot_n_en_est_pas_une() {
		let table = parse(SAMPLE);
		assert!(!table.marked.iter().any(|m| m.pid == 800));
	}

	#[test]
	fn les_processus_d_un_agent_se_retrouvent_meme_rattaches_a_launchd() {
		let table = parse(SAMPLE);
		assert_eq!(of_session(&table, "agent-parti"), vec![600, 601]);
	}

	#[test]
	fn le_menage_epargne_les_agents_vivants_et_les_relais() {
		let table = parse(SAMPLE);
		let pids = left_behind(&table, &["agent-detache".to_string()]);
		assert_eq!(pids, vec![600, 601]);
	}
}
