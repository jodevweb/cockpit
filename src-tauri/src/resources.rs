//! Ce que le cockpit fait peser sur la machine.
//!
//! Un cockpit qui lance des agents et des serveurs de dev finit par tenir
//! plusieurs centaines de mégaoctets, sans que rien ne dise lesquels. La
//! question posée à l'usage n'est pas « combien » mais « à cause de quoi » :
//! l'application elle-même, un agent qui a ouvert un navigateur, un `pnpm dev`
//! oublié dans un terminal. On mesure donc par sous-arbre, chacun rattaché à ce
//! qui l'a lancé.
//!
//! Une seule commande `ps` pour tout le monde, puis l'arbre est reconstitué en
//! mémoire. Interroger chaque processus séparément coûterait un `fork` par
//! ligne, sur une liste qui en compte plusieurs centaines.
//!
//! Le pourcentage processeur se calcule entre deux relevés. Celui de `ps` est
//! une moyenne depuis le lancement du processus : sur un agent démarré il y a
//! une heure, il ne dit rien de ce qu'il fait maintenant. On garde donc le
//! temps processeur du relevé précédent et on regarde ce qui a été consommé
//! depuis — la première mesure n'a pas de point de comparaison et rend zéro.

use crate::error::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
	/// Mémoire résidente du sous-arbre, en mégaoctets.
	pub memory_mb: f64,
	/// Part de processeur consommée depuis le relevé précédent, en pourcentage
	/// d'un cœur — 200 % signifie deux cœurs saturés.
	pub cpu: f64,
	/// Processus comptés, le sous-arbre compris.
	pub processes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedUsage {
	/// Identifiant côté cockpit : session d'agent, ou onglet de terminal.
	pub id: String,
	pub cwd: String,
	pub usage: Usage,
	/// Ce qui pèse le plus dans ce sous-arbre, quand ce n'est pas le processus
	/// lui-même — « Google Chrome », « next-server ». C'est souvent la vraie
	/// réponse à « pourquoi cet agent tient 300 Mo ».
	pub heaviest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReport {
	/// Le processus du cockpit seul, sans rien de ce qu'il a lancé.
	pub app: Usage,
	/// Tout ce que le cockpit tient : lui-même et sa descendance entière.
	pub total: Usage,
	pub agents: Vec<NamedUsage>,
	pub terminals: Vec<NamedUsage>,
	/// Mémoire de la machine, pour situer le tout.
	pub machine_total_mb: f64,
	pub machine_used_mb: f64,
}

struct Sample {
	ppid: u32,
	rss_kb: u64,
	cpu_seconds: f64,
	command: String,
}

/// Temps processeur du relevé précédent, par processus.
static PREVIOUS: Mutex<Option<(Instant, HashMap<u32, f64>)>> = Mutex::new(None);

/// « 12:34.56 », « 1-02:03:04 » — le format de `ps`, en secondes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_cpu_time(value: &str) -> f64 {
	let (days, rest) = match value.split_once('-') {
		Some((d, rest)) => (d.parse::<f64>().unwrap_or(0.0), rest),
		None => (0.0, value),
	};
	let mut seconds = 0.0;
	for part in rest.split(':') {
		seconds = seconds * 60.0 + part.parse::<f64>().unwrap_or(0.0);
	}
	days * 86_400.0 + seconds
}

/// Sous Windows, pas de `ps` : le système donne la même table directement
/// (voir `platform::processes`), sans lancer de programme. Sous Linux, la
/// même table vient de `/proc`.
#[cfg(any(windows, target_os = "linux"))]
fn read_processes() -> HashMap<u32, Sample> {
	crate::platform::processes()
		.into_iter()
		.map(|process| {
			(
				process.pid,
				Sample {
					ppid: process.ppid,
					rss_kb: process.rss_kb,
					cpu_seconds: process.cpu_seconds,
					command: process.name,
				},
			)
		})
		.collect()
}

#[cfg(target_os = "macos")]
fn read_processes() -> HashMap<u32, Sample> {
	let output = crate::platform::quiet_std(
		std::process::Command::new("ps").args(["-axo", "pid=,ppid=,rss=,cputime=,comm="]),
	)
	.output();
	let Ok(output) = output else {
		return HashMap::new();
	};

	let mut table = HashMap::new();
	for line in String::from_utf8_lossy(&output.stdout).lines() {
		let mut fields = line.split_whitespace();
		let (Some(pid), Some(ppid), Some(rss), Some(time)) =
			(fields.next(), fields.next(), fields.next(), fields.next())
		else {
			continue;
		};
		let Ok(pid) = pid.parse::<u32>() else { continue };
		let command = fields.collect::<Vec<_>>().join(" ");
		table.insert(
			pid,
			Sample {
				ppid: ppid.parse().unwrap_or(0),
				rss_kb: rss.parse().unwrap_or(0),
				cpu_seconds: parse_cpu_time(time),
				command,
			},
		);
	}
	table
}

/// Nom lisible d'un exécutable : le cockpit affiche « claude », pas son chemin.
fn short_name(command: &str) -> String {
	command
		.split('/')
		.next_back()
		.unwrap_or(command)
		.split_whitespace()
		.next()
		.unwrap_or(command)
		.to_string()
}

struct Walker<'a> {
	processes: &'a HashMap<u32, Sample>,
	children: HashMap<u32, Vec<u32>>,
	previous: &'a HashMap<u32, f64>,
	elapsed: f64,
}

impl Walker<'_> {
	/// Somme un processus et toute sa descendance.
	///
	/// La mémoire résidente s'additionne, ce qui surestime un peu : deux
	/// processus issus du même binaire partagent leurs pages. C'est la mesure
	/// que donnent le moniteur d'activité et `ps`, et celle qu'on reconnaît.
	fn walk(&self, pid: u32, out: &mut Usage, heaviest: &mut (u64, String)) {
		let Some(sample) = self.processes.get(&pid) else {
			return;
		};
		out.memory_mb += sample.rss_kb as f64 / 1024.0;
		out.processes += 1;

		if self.elapsed > 0.0 {
			if let Some(before) = self.previous.get(&pid) {
				let spent = (sample.cpu_seconds - before).max(0.0);
				out.cpu += spent / self.elapsed * 100.0;
			}
		}

		if sample.rss_kb > heaviest.0 {
			*heaviest = (sample.rss_kb, short_name(&sample.command));
		}

		for child in self.children.get(&pid).into_iter().flatten() {
			self.walk(*child, out, heaviest);
		}
	}

	fn subtree(&self, pid: u32) -> (Usage, Option<String>) {
		let mut usage = Usage {
			memory_mb: 0.0,
			cpu: 0.0,
			processes: 0,
		};
		let mut heaviest = (0u64, String::new());
		self.walk(pid, &mut usage, &mut heaviest);

		// Le plus lourd n'est signalé que s'il n'est pas la racine elle-même :
		// dire d'un agent que son plus gros processus est « claude » n'apprend
		// rien, dire que c'est « Google Chrome » explique tout.
		let root_name = self.processes.get(&pid).map(|s| short_name(&s.command));
		let heaviest = match (heaviest.1.is_empty(), root_name) {
			(true, _) => None,
			(false, Some(root)) if root == heaviest.1 => None,
			(false, _) => Some(heaviest.1),
		};
		(usage, heaviest)
	}
}

/// Mémoire physique totale et utilisée de la machine, en mégaoctets.
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn machine_memory() -> (f64, f64) {
	crate::platform::machine_memory_mb()
}

/// Mémoire physique totale et utilisée de la machine, en mégaoctets.
#[cfg(target_os = "macos")]
pub(crate) fn machine_memory() -> (f64, f64) {
	let total = crate::platform::quiet_std(std::process::Command::new("sysctl").args(["-n", "hw.memsize"]))
		.output()
		.ok()
		.and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok())
		.unwrap_or(0.0)
		/ 1024.0
		/ 1024.0;

	// `vm_stat` compte en pages ; « utilisée » = tout sauf ce qui est libre ou
	// spéculatif, ce qui correspond à ce qu'affiche le moniteur d'activité.
	let used = crate::platform::quiet_std(&mut std::process::Command::new("vm_stat"))
		.output()
		.ok()
		.map(|out| {
			let text = String::from_utf8_lossy(&out.stdout).to_string();
			let page = 16_384.0;
			let value = |key: &str| -> f64 {
				text.lines()
					.find(|line| line.starts_with(key))
					.and_then(|line| line.split(':').nth(1))
					.map(|v| v.trim().trim_end_matches('.').parse::<f64>().unwrap_or(0.0))
					.unwrap_or(0.0)
			};
			(value("Pages active") + value("Pages wired down") + value("Pages occupied by compressor"))
				* page / 1024.0 / 1024.0
		})
		.unwrap_or(0.0);

	(total, used)
}

/// Relève la consommation du cockpit et de ce qu'il a lancé.
///
/// `agents` et `terminals` associent un identifiant côté interface au processus
/// racine correspondant, pour que chaque mégaoctet ait un responsable nommé.
pub fn report(
	agents: Vec<(String, String, u32)>,
	terminals: Vec<(String, String, u32)>,
) -> Result<ResourceReport> {
	let processes = read_processes();
	let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
	for (pid, sample) in &processes {
		children.entry(sample.ppid).or_default().push(*pid);
	}

	let now = Instant::now();
	let mut guard = PREVIOUS.lock().unwrap_or_else(|e| e.into_inner());
	let (elapsed, previous) = match guard.as_ref() {
		Some((at, table)) => (now.duration_since(*at).as_secs_f64(), table.clone()),
		None => (0.0, HashMap::new()),
	};

	let walker = Walker {
		processes: &processes,
		children,
		previous: &previous,
		elapsed,
	};

	let me = std::process::id();
	let (mut total, _) = walker.subtree(me);

	// Ce qu'un agent a lancé puis lâché est rattaché à launchd : hors de toute
	// descendance, donc hors de cette mesure, alors même que c'est souvent le
	// plus lourd — voir `strays.rs`. On le retrouve par la marque de l'agent, et
	// on part de ce qui est rattaché à launchd pour ne compter chaque sous-arbre
	// qu'une fois. Les racines d'agents détachés sont exclues : elles sont déjà
	// mesurées comme agents.
	let roots: Vec<u32> = agents.iter().map(|(_, _, pid)| *pid).collect();
	let strays: Vec<(String, u32)> = crate::strays::read()
		.marked
		.into_iter()
		.filter(|marked| marked.detached() && !roots.contains(&marked.pid))
		.map(|marked| (marked.session, marked.pid))
		.collect();
	for (_, pid) in &strays {
		let (usage, _) = walker.subtree(*pid);
		total.memory_mb += usage.memory_mb;
		total.cpu += usage.cpu;
		total.processes += usage.processes;
	}

	// Le cockpit seul : son sous-arbre moins ce qu'il a lancé, c'est-à-dire la
	// ligne du processus lui-même.
	let app = processes
		.get(&me)
		.map(|sample| Usage {
			memory_mb: sample.rss_kb as f64 / 1024.0,
			cpu: if elapsed > 0.0 {
				previous
					.get(&me)
					.map(|before| (sample.cpu_seconds - before).max(0.0) / elapsed * 100.0)
					.unwrap_or(0.0)
			} else {
				0.0
			},
			processes: 1,
		})
		.unwrap_or(Usage {
			memory_mb: 0.0,
			cpu: 0.0,
			processes: 0,
		});

	let measure = |list: Vec<(String, String, u32)>| -> Vec<NamedUsage> {
		list.into_iter()
			.map(|(id, cwd, pid)| {
				let (mut usage, mut heaviest) = walker.subtree(pid);
				for (session, stray) in &strays {
					if *session != id {
						continue;
					}
					let (extra, extra_heaviest) = walker.subtree(*stray);
					usage.memory_mb += extra.memory_mb;
					usage.cpu += extra.cpu;
					usage.processes += extra.processes;
					// Un serveur lâché qui pèse : c'est lui qu'il faut nommer.
					if heaviest.is_none() {
						heaviest = extra_heaviest.or_else(|| {
							walker.processes.get(stray).map(|s| short_name(&s.command))
						});
					}
				}
				NamedUsage {
					id,
					cwd,
					usage,
					heaviest,
				}
			})
			.collect()
	};
	let agents = measure(agents);
	let terminals = measure(terminals);

	*guard = Some((
		now,
		processes
			.iter()
			.map(|(pid, sample)| (*pid, sample.cpu_seconds))
			.collect(),
	));
	drop(guard);

	let (machine_total_mb, machine_used_mb) = machine_memory();

	Ok(ResourceReport {
		app,
		total,
		agents,
		terminals,
		machine_total_mb,
		machine_used_mb,
	})
}

/// Un plafond illisible (mémoire machine à zéro) ne bloque pas : même
/// doctrine que `MissionsConfig::quota_allows`, un dispositif qui s'arrête
/// parce qu'il n'a pas su lire un chiffre est plus difficile à diagnostiquer
/// qu'un dispositif qui continue.
fn ceiling_breached(total_mb: f64, used_mb: f64, ceiling_percent: u64) -> bool {
	if ceiling_percent >= 100 || total_mb <= 0.0 {
		return false;
	}
	(used_mb / total_mb * 100.0) >= ceiling_percent as f64
}

/// Vrai si la mémoire de la machine dépasse le plafond configuré — plus aucun
/// agent ne doit démarrer tant que ce n'est pas retombé dessous.
pub fn over_ceiling(ceiling_percent: u64) -> bool {
	let (total, used) = machine_memory();
	ceiling_breached(total, used, ceiling_percent)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn le_temps_processeur_se_lit_dans_les_deux_formats() {
		assert!((parse_cpu_time("12:34.56") - 754.56).abs() < 0.01);
		assert!((parse_cpu_time("1-02:03:04") - 93_784.0).abs() < 0.01);
		assert!((parse_cpu_time("0:00.00")).abs() < 0.01);
	}

	#[test]
	fn le_nom_court_retient_l_executable() {
		assert_eq!(short_name("/Users/x/.local/bin/claude"), "claude");
		assert_eq!(short_name("next-server (v16.2.7)"), "next-server");
		assert_eq!(short_name("node"), "node");
	}

	#[test]
	fn le_plafond_se_declenche_au_seuil_et_pas_avant() {
		assert!(!ceiling_breached(32_000.0, 27_000.0, 85));
		assert!(ceiling_breached(32_000.0, 27_200.0, 85));
	}

	#[test]
	fn cent_pour_cent_desactive_le_plafond() {
		assert!(!ceiling_breached(32_000.0, 32_000.0, 100));
	}

	#[test]
	fn une_mesure_illisible_ne_bloque_pas() {
		assert!(!ceiling_breached(0.0, 0.0, 85));
	}
}
