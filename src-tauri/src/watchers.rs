//! Ce qui tourne en fond pendant que la fenêtre est ouverte : la surveillance
//! des journaux de session et du dépôt, et les boucles qui font avancer
//! missions, Permanence, orchestrateur et périmètres d'écriture.
//!
//! Sorti tel quel de `lib.rs`. Le module voit tout ce que voit la racine
//! (`use super::*`) ; `run` y lance ces boucles.

use super::*;

/// Au-delà, c'est qu'un plan a dérapé plutôt qu'il n'a découpé.
pub(crate) const MAX_RUNNING_TASKS: usize = 4;

/// Toutes missions confondues. Le plafond par mission ne protège de rien quand
/// c'est le lanceur lui-même qui s'emballe : celui-ci borne la machine.
pub(crate) const MAX_RUNNING_TASKS_TOTAL: usize = 8;

/// Délai laissé à un exécutant pour se rattacher à sa tâche, en secondes.
///
/// Large à dessein : créer un worktree sur un gros dépôt et démarrer un CLI peut
/// demander une minute. Ce qui compte est qu'il y ait une fin — une tâche
/// « en cours » que personne ne rejoindra ne doit pas le rester jusqu'au soir.
pub(crate) const LAUNCH_GRACE_SECONDS: i64 = 300;

/// Nombre d'exécutants en cours sur l'ensemble des missions.
pub(crate) fn running_tasks_everywhere() -> usize {
	mission::list()
		.iter()
		.flat_map(|mission| mission.tasks.iter())
		.filter(|task| task.state == mission::TaskState::Running)
		.count()
}

/// Lance les exécutants dont le terrain est prêt.
///
/// Approuver un plan, c'est donner le feu vert : demander un second clic par
/// tâche revient à faire deux fois la même décision. Une tâche part donc dès
/// que sa base existe — la branche d'intégration, ou celle d'une sœur qui a
/// déjà livré quand une dépendance a été déclarée.
pub(crate) async fn launch_ready_tasks(app: AppHandle, id: &str) {
	let Ok(mission) = mission::get(id) else { return };
	if mission.state != mission::MissionState::Running || mission.paused {
		return;
	}

	// La réserve avant le travail. On ne tue rien : les tâches en cours vont au
	// bout et le maître continue — on cesse seulement d'en ajouter. Se
	// retrouver à sec un mardi après-midi coûte plus cher qu'une mission qui
	// attend une heure.
	let config = cfg();
	if !config.missions.quota_allows(worst_quota()) {
		static DIT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
		// Une fois par heure, pas à chaque tour de boucle : la boucle passe
		// toutes les six secondes, et un journal qui répète six cents fois la
		// même ligne ne se lit plus.
		let mut dit = DIT.lock().unwrap_or_else(|guard| guard.into_inner());
		if dit.map(|at| at.elapsed().as_secs() > 3600).unwrap_or(true) {
			*dit = Some(std::time::Instant::now());
			journal::record(
				"mission",
				&i18n::t("lib.mission.launchSuspendedQuota"),
				&mission.title,
				false,
				&i18n::tf("lib.mission.quotaFloor", &[("floor", &config.missions.quota_floor())]),
			);
		}
		return;
	}

	let mut running = mission
		.tasks
		.iter()
		.filter(|task| task.state == mission::TaskState::Running)
		.count();

	// Les rôles qui jugent le travail des autres, d'après le catalogue du projet
	// de la mission.
	let verifiers: std::collections::HashSet<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();

	let implementation_done = mission.implementation_done(|role| verifiers.contains(role));

	for task in &mission.tasks {
		if task.state != mission::TaskState::Planned || running >= MAX_RUNNING_TASKS {
			continue;
		}
		if running_tasks_everywhere() >= MAX_RUNNING_TASKS_TOTAL {
			journal::record(
				"mission",
				&i18n::t("lib.mission.launchSuspended"),
				&mission.title,
				false,
				&i18n::tf("lib.mission.tooManyWorkers", &[("count", &MAX_RUNNING_TASKS_TOTAL)]),
			);
			return;
		}
		// Une tâche sans identifiant est intraçable : on ne saurait ni lui
		// rattacher sa session ni la marquer lancée, et on repartirait dessus à
		// chaque tour. Mieux vaut l'échouer une fois que la relancer sans fin.
		if task.id.trim().is_empty() {
			let _ = mission::set_task_state(
				&mission.id,
				&task.id,
				mission::TaskState::Failed,
				&i18n::t("lib.mission.taskWithoutId"),
			);
			continue;
		}
		// Recette et relecture jugent ce que les autres produisent : parties en
		// même temps qu'eux, elles relisent une branche vide et rendent un
		// compte rendu sur rien. On les retient jusqu'à ce que l'implémentation
		// ait livré — le bouton « Forcer » reste là pour passer outre.
		if verifiers.contains(&task.role) && !implementation_done {
			continue;
		}
		// Une base qui n'est pas l'intégration désigne une sœur : tant qu'elle
		// n'a rien livré, sa branche n'existe pas et partir dessus créerait un
		// worktree vide. Mais toutes les attentes ne finissent pas : une sœur à
		// bout de reprises ne livrera jamais, et une base qui ne désigne aucune
		// tâche du plan n'a personne à attendre. La tâche restait alors « à
		// faire » indéfiniment dans une mission « en cours » que plus rien ne
		// faisait avancer, sans que rien ne le dise.
		if let Some(raison) = mission::blocking_reason(&mission, task) {
			let _ = mission::set_task_state(&mission.id, &task.id, mission::TaskState::Failed, &raison);
			journal::record(
				"mission",
				&i18n::t("lib.mission.taskBlocked"),
				&task.title,
				false,
				&raison,
			);
			continue;
		}
		if !task.base.trim().is_empty() && task.base != mission.branch {
			let ready = mission.tasks.iter().any(|sister| {
				sister.branch == task.base
					&& matches!(
						sister.state,
						mission::TaskState::Delivered | mission::TaskState::Integrated
					)
			});
			if !ready {
				continue;
			}
		}

		// La réservation d'abord : ce qui suit attend, et rien ne doit repasser
		// sur cette tâche pendant ce temps.
		match mission::claim_task(&mission.id, &task.id) {
			Ok(true) => running += 1,
			_ => continue,
		}

		match orchestrator::prepare_worktree(&mission, task).await {
			Ok(worktree) => {
				let _ = mission::set_task_worktree(&mission.id, &task.id, &worktree);
			}
			Err(error) => {
				let _ = mission::set_task_state(
					&mission.id,
					&task.id,
					mission::TaskState::Failed,
					&i18n::tf("lib.mission.worktreeFailed", &[("error", &error)]),
				);
				running -= 1;
				continue;
			}
		}

		match launch_task_agent(app.clone(), &mission.id, &task.id, executions::COCKPIT).await {
			Ok(_) => {}
			Err(error) => {
				let _ = mission::set_task_state(&mission.id, &task.id, mission::TaskState::Failed, &error.to_string());
				running -= 1;
			}
		}
	}
}

/// Fait avancer les missions sans qu'on ait à cliquer.
///
/// Une tâche qui vient d'être livrée peut en débloquer une autre : c'est ici
/// qu'on s'en aperçoit, plutôt que d'attendre un geste de l'utilisateur ou une
/// initiative du maître.
/// Constate ce que les exécutants ont fini.
///
/// Un exécutant n'a aucun moyen de dire qu'il a terminé : il écrit « travail
/// terminé » dans sa conversation, ce qui ne vaut rien pour la machine, puis son
/// processus rend la main. C'est cette fin de processus qui fait foi — sans
/// quoi les tâches restaient « en cours » indéfiniment, la progression ne
/// bougeait plus, et la mission n'atteignait jamais son intégration.
///
/// Rend vrai si quelque chose a changé.
/// Où en est le travail à vérifier, branche par branche.
///
/// Une ligne lisible plutôt qu'une structure : elle finira dans la consigne d'un
/// agent, qui s'en servira pour demander un diff. `backend=a1b2c3 frontend=d4e5f6`
/// suffit à dire ce qui a bougé depuis la dernière relecture.
pub(crate) async fn implementation_state(
	mission: &mission::Mission,
	verifiers: &std::collections::HashSet<String>,
) -> Option<String> {
	let repo = std::path::Path::new(&mission.cwd);
	let mut reperes = Vec::new();
	for task in &mission.tasks {
		if verifiers.contains(&task.role) || task.branch.trim().is_empty() {
			continue;
		}
		if let Ok(sha) = git::run_git(repo, &["rev-parse", "--short", &task.branch]).await {
			let sha = sha.trim();
			if !sha.is_empty() {
				reperes.push(format!("{}={sha}", task.branch));
			}
		}
	}
	(!reperes.is_empty()).then(|| reperes.join(" "))
}

/// Ce qu'une vérification a conclu, lu dans son propre rapport.
///
/// Le cockpit ne demande pas au moteur de remplir un formulaire : il lui
/// demande une ligne, et va la chercher. C'est ce qui rend la lecture portable
/// — un moteur qui ne connaît ni nos outils ni notre JSON sait écrire une
/// phrase, et c'est tout ce dont on a besoin pour savoir si la mission peut
/// partir.
/// Le verdict d'une vérification, tel que le cockpit l'a relevé lui-même.
///
/// Le relevé d'abord, le fil du moteur en repli. L'ordre n'est pas
/// esthétique : pendant des semaines, ce verdict n'a jamais été posé sur une
/// seule tâche, parce qu'on allait le chercher dans le fichier d'un tiers —
/// écrit dans un worktree qu'on venait de supprimer, et, dès que l'isolation
/// est active, dans un `$HOME` que le poste ne balayait même pas. La lecture
/// échouait, et une lecture échouée ne se distinguait pas d'un rapport sans
/// refus. Ce que le cockpit a entendu passer vaut mieux que ce qu'il espère
/// relire.
///
/// `session` est l'agent du cockpit, `engine` sa conversation chez le moteur —
/// la seconde ne sert plus qu'aux exécutions antérieures à ce relevé.
pub(crate) fn verdict_of(session: &str, engine: Option<&str>) -> Option<mission::Verdict> {
	let releve = executions::for_session(session)
		.into_iter()
		.rev()
		.find_map(|exec| mission::Verdict::parse(&exec.verdict));
	releve.or_else(|| engine.and_then(verdict_from_session))
}

/// Le verdict est la conclusion : on lit la fin du fil, pas le début.
pub(crate) fn verdict_from_session(session: &str) -> Option<mission::Verdict> {
	let session = session.trim();
	if session.is_empty() {
		return None;
	}
	let file = remote::session_file(session)?;
	let events = sessions::read_timeline(std::path::Path::new(&file), 400).ok()?;
	events
		.iter()
		.rev()
		.filter(|event| event.kind == "assistant" && !event.is_sidechain)
		.find_map(|event| mission::read_verdict(&event.text))
}

pub(crate) async fn collect_finished_tasks(app: &AppHandle, id: &str) -> bool {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else {
		return false;
	};
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return false;
	};
	let agents = agents.inner().clone();
	let verifiers: std::collections::HashSet<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();

	let mut changed = false;
	for task in &mission.tasks {
		if task.state != mission::TaskState::Running {
			continue;
		}
		// Une tâche réservée dont l'agent n'est pas encore rattaché n'est pas
		// finie : elle n'a simplement pas encore commencé. Mais l'attente a une
		// limite — créer un worktree et démarrer un CLI prend des secondes, pas
		// une heure. Passé ce délai, plus personne ne viendra s'y rattacher :
		// faute de ce filet, la tâche restait « en cours » indéfiniment, sans
		// conversation à ouvrir pour comprendre, et occupait une place au plafond
		// des exécutants.
		let Some(session) = &task.session_id else {
			if task.running_seconds().unwrap_or(0) > LAUNCH_GRACE_SECONDS {
				let _ = mission::set_task_state(
					id,
					&task.id,
					mission::TaskState::Failed,
					&i18n::t("lib.mission.noWorkerAttached"),
				);
				changed = true;
			}
			continue;
		};
		if agent::is_working(&agents, session) {
			continue;
		}

		// Mort sans avoir rien dit : le lancement a échoué, la tâche n'a pas
		// travaillé. La marquer livrée ferait croire la mission terminée.
		if !agent::has_answered(&agents, session) {
			let _ = mission::set_task_state(
				id,
				&task.id,
				mission::TaskState::Failed,
				&i18n::t("lib.mission.workerDiedSilent"),
			);
			let _ = agent::stop(&agents, session);
			changed = true;
			continue;
		}

		// Ce qu'elle laisse derrière elle, pour que le maître sache quoi relire.
		// Une relecture ne commite rien par nature : l'absence de commit n'est
		// pas un échec, seulement une information.
		let commits = git::run_git(
			std::path::Path::new(&mission.cwd),
			&["rev-list", "--count", &format!("{}..{}", mission.branch, task.branch)],
		)
		.await
		.ok()
		.and_then(|raw| raw.trim().parse::<u32>().ok())
		.unwrap_or(0);

		// Rien sur sa branche ne veut pas dire rien fait. Un exécutant peut
		// s'être créé une branche dans son worktree — par habitude de nommage,
		// ou parce qu'il a jugé le sujet différent — et son travail est alors
		// bien là, mais pas où l'intégration ira le chercher. Elle fusionnerait
		// une branche vide, la mission se refermerait, et le code resterait sur
		// une branche que plus rien ne nomme. On regarde donc où il est
		// vraiment avant de conclure.
		let mut derive = String::new();
		if commits == 0 && !task.worktree.trim().is_empty() {
			let dessus = git::current_branch(std::path::Path::new(&task.worktree))
				.await
				.unwrap_or_default();
			let dessus = dessus.trim().to_string();
			if !dessus.is_empty() && dessus != task.branch.trim() {
				let ailleurs = git::run_git(
					std::path::Path::new(&task.worktree),
					&["rev-list", "--count", &format!("{}..{dessus}", mission.branch)],
				)
				.await
				.ok()
				.and_then(|raw| raw.trim().parse::<u32>().ok())
				.unwrap_or(0);
				if ailleurs > 0 {
					let _ = mission::set_task_actual_branch(id, &task.id, &dessus);
					journal::record(
						"mission",
						&i18n::t("lib.mission.workerOtherBranch"),
						&task.title,
						false,
						&i18n::tf(
							"lib.mission.workerOtherBranchDetail",
							&[("count", &ailleurs), ("actual", &dessus), ("expected", &task.branch)],
						),
					);
					derive = format!(
						" {}",
						i18n::tf(
							"lib.mission.workerOtherBranchNote",
							&[("count", &ailleurs), ("actual", &dessus), ("expected", &task.branch)],
						)
					);
				}
			}
		}

		let _ = mission::set_task_state(
			id,
			&task.id,
			mission::TaskState::Delivered,
			&match commits {
				0 => format!("{}{derive}", i18n::t("lib.mission.workerDoneNoCommit")),
				1 => i18n::t("lib.mission.workerDoneOneCommit"),
				n => i18n::tf("lib.mission.workerDoneCommits", &[("count", &n)]),
			},
		);
		// Un rendu qui porte du code passe les portes du dépôt avant d'être
		// intégrable. Une vérification aussi, dès qu'elle commite : une recette
		// qui ajoute ses tests apporte du code. Seuls ses commits à elle
		// comptent, pas le travail de ses sœurs reçu avant son lancement
		// (`sync_verifier_worktree`), qui ne lui donne rien à faire juger.
		let brings_code = if verifiers.contains(&task.role) {
			crate::orchestrator::authored_commits(&mission, task, |role| verifiers.contains(role)).await
		} else {
			commits > 0 || !derive.is_empty()
		};
		if brings_code {
			let _ = gates::start(id, &task.id);
		}
		// Capturé maintenant, tant que l'agent est encore vivant : une fois
		// `stop` appelé plus bas, plus rien ne sait retrouver son identifiant de
		// session (l'entrée disparaît du registre). C'est ce qui laissait
		// `engine_session` vide toute la mission — une reprise repartait à froid,
		// sans la conversation qui allait avec son checkpoint, et le verdict
		// ci-dessous ne trouvait jamais de fil à lire.
		let claude_session = agents.engine_session_of(session);
		if let Some(claude_session) = &claude_session {
			let _ = mission::set_task_engine_session(id, &task.id, claude_session);
		}

		// Une vérification qui rend son verdict note où en était le travail :
		// à sa reprise, elle saura ce qu'elle a déjà lu et n'aura pas à tout
		// reprendre pour valider une correction d'une ligne.
		if verifiers.contains(&task.role) {
			if let Some(repere) = implementation_state(&mission, &verifiers).await {
				let _ = mission::set_checkpoint(id, &task.id, &repere);
			}
			// Et son verdict devient un fait de la mission, pas une phrase que
			// le maître est libre de ne pas relire. Une vérification qui a rendu
			// sans conclure n'est pas une vérification sans reproche : faute de
			// conclusion lisible, elle est indécise, et le dira.
			let verdict = verdict_of(session, claude_session.as_deref()).unwrap_or(mission::Verdict::Undecided);
			{
				let _ = mission::set_task_verdict(id, &task.id, verdict);
				if verdict == mission::Verdict::Undecided {
					journal::record(
						"mission",
						&i18n::t("lib.mission.checkNoVerdict"),
						&task.title,
						false,
						&i18n::t("lib.mission.checkNoVerdictDetail"),
					);
				}
				if verdict == mission::Verdict::Blocking {
					journal::record(
						"mission",
						&i18n::t("lib.mission.checkBlocking"),
						&task.title,
						false,
						&i18n::t("lib.mission.checkBlockingDetail"),
					);
				}
			}
		}

		// Et on le libère. Un CLI qui a rendu sa copie continue d'occuper une
		// centaine de mégaoctets, son serveur MCP avec lui, sans plus rien avoir
		// à faire : une mission de cinq tâches reprise deux fois en laissait
		// vingt-trois derrière elle. Le travail, lui, est dans le worktree ; la
		// conversation reste lisible sur le disque.
		let _ = agent::stop(&agents, session);
		changed = true;
	}
	changed
}

/// Coupe les agents de mission que plus aucune tâche ne réclame.
///
/// Filet plutôt que règle : chaque chemin qui termine une tâche coupe déjà son
/// exécutant. Mais il suffit qu'un seul l'oublie pour qu'un CLI reste en vie
/// jusqu'à la fermeture de l'app, et l'addition se compte en gigaoctets. On
/// repasse donc derrière, sur les sessions que les missions désignent — jamais
/// sur un agent ouvert à la main, qui n'appartient à personne.
pub(crate) fn reap_stray_agents(app: &AppHandle) -> usize {
	use tauri::Manager;
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return 0;
	};
	let agents = agents.inner().clone();

	let mut reaped = 0;
	let missions = mission::list();
	for mission in &missions {
		let close = mission.state == mission::MissionState::Done || mission.state == mission::MissionState::Failed;

		if let Some(session) = &mission.master_session {
			if close && !agent::is_working(&agents, session) {
				let _ = agent::stop(&agents, session);
				let _ = mission::update_master_session(&mission.id, None);
				reaped += 1;
			} else if !close {
				if let Some(age) = agent::turn_age(&agents, session) {
					if age >= MASTER_TURN_TIMEOUT {
						let _ = agent::stop(&agents, session);
						journal::record(
							"mission",
							&i18n::t("lib.mission.masterTimedOut"),
							&mission.title,
							false,
							&i18n::tf(
								"lib.mission.masterTimedOutDetail",
								&[("minutes", &(age.as_secs() / 60))],
							),
						);
						reaped += 1;
					}
				}
			}
		}

		for task in &mission.tasks {
			let Some(session) = &task.session_id else { continue };
			if task.state == mission::TaskState::Running {
				continue;
			}
			if agent::is_working(&agents, session) {
				continue;
			}
			let _ = agent::stop(&agents, session);
			reaped += 1;
		}
	}

	// Ce que plus aucune mission ne désigne : l'ancienne session d'un maître
	// remplacé ou d'un exécutant relancé, ou l'agent d'une mission purgée. Il
	// a rendu son tour et personne ne lui écrira plus. En plein tour, on le
	// laisse finir — c'est peut-être un lancement dont la mission n'a pas
	// encore noté la session.
	let designated: std::collections::HashSet<&str> = missions
		.iter()
		.flat_map(|mission| {
			mission
				.master_session
				.as_deref()
				.into_iter()
				.chain(mission.tasks.iter().filter_map(|task| task.session_id.as_deref()))
		})
		.collect();
	for (session, _, working) in agent::mission_agents(&agents) {
		if working || designated.contains(session.as_str()) {
			continue;
		}
		let _ = agent::stop(&agents, &session);
		reaped += 1;
	}
	reaped
}

/// Fait passer la mission à l'intégration quand tout est livré.
///
/// Le maître a rendu la main depuis longtemps : le CLI termine à la fin de
/// chaque tour. On le rappelle donc avec ce qu'il lui reste à faire, plutôt que
/// d'attendre une initiative de sa part qui ne viendra pas.
pub(crate) async fn move_to_integration(app: &AppHandle, id: &str) {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else { return };
	if mission.state != mission::MissionState::Running || mission.tasks.is_empty() {
		return;
	}
	// Aucun rôle n'est mis à part ici : c'est bien tout le monde qu'on attend,
	// recette et relecture comprises.
	if !mission.implementation_done(|_| false) {
		return;
	}

	let _ = mission::set_state(
		id,
		mission::MissionState::Integrating,
		&i18n::t("lib.mission.allDelivered"),
	);

	// Inutile d'en relancer un si le précédent travaille encore ; et s'il a
	// fini, on le coupe avant d'en lancer un autre — sans quoi chaque phase de
	// la mission empilait un maître de plus, tous vivants.
	if let Some(agents) = app.try_state::<agent::SharedAgents>() {
		if let Some(session) = &mission.master_session {
			if agent::is_working(agents.inner(), session) {
				return;
			}
			let _ = agent::stop(agents.inner(), session);
		}
	}

	// Ce qu'il ne peut pas savoir : que la recette et la relecture ont rendu un
	// verdict, et qu'un refus se traite en renvoyant la tâche plutôt qu'en
	// corrigeant soi-même. La suite — intégrer, rendre compte, ouvrir la PR —
	// est décrite par les outils.
	let brief = "All workers have delivered. QA and review ended their report with a \
	             verdict: read them before anything else.\n\n\
	             On a blocking verdict, do not fix it yourself — `rework` the faulty task, \
	             passing on the points to rework. It will restart on its own, the checks \
	             will judge again, and you will be called back. Three reworks at most per \
	             task; beyond that, explain what is blocking and stop there.\n\n\
	             When the repository declares checks, `integrate` only merges the tasks that \
	             pass them. A failed check comes back with its output: `rework` the task with \
	             it, the same way as a blocking verdict."
		.to_string();
	if let Err(error) = launch_master(
		app.clone(),
		id.to_string(),
		Some(brief),
		executions::Origin::cockpit(config::MASTER_ROLE),
	)
	.await
	{
		journal::record(
			"mission",
			&i18n::t("lib.mission.masterNotRelaunched"),
			&mission.title,
			false,
			&error.to_string(),
		);
	}
}

/// Au-delà, une intégration qui n'a pas bougé n'attend plus rien.
///
/// Assez long pour laisser un maître travailler sans être doublé — il peut
/// rester silencieux le temps d'un merge ou d'une lecture de branche — assez
/// court pour qu'une panne se voie dans la matinée plutôt qu'au retour de
/// déjeuner.
pub(crate) const INTEGRATION_STALL_SECONDS: i64 = 240;

/// Au-delà, un tour de maître qui n'a pas rendu la main n'attend plus une fin
/// de merge : il est bloqué.
///
/// Ni la mort du process ni un `result` de fin de tour ne garantissent qu'on
/// s'en aperçoive — un CLI figé ou un réseau qui ne répond plus laisse
/// `is_working` vrai indéfiniment, et `revive_integration`/
/// `move_to_integration` attendent alors pour rien : c'est exactement ce
/// qu'a montré une mission réelle, bloquée 90 minutes d'affilée sur son
/// intégration. Généreux — un vrai merge conflictuel ou une grosse relecture
/// peuvent prendre du temps — mais borné : voir `reap_stray_agents`.
pub(crate) const MASTER_TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Remet un maître debout sur une intégration qui s'est arrêtée toute seule.
///
/// On ne double jamais un maître qui travaille : c'est seulement quand plus
/// personne ne tient la mission, et qu'elle n'a rien écrit depuis un moment,
/// qu'on la reprend. Le compteur repart à chaque écriture, donc un maître
/// relancé qui avance n'est pas relancé de nouveau.
/// Relances d'un maître d'intégration tolérées sans que rien n'avance.
const MAX_FRUITLESS_REVIVALS: u32 = 3;

/// Le dépôt a-t-il un remote où pousser ? Dans le doute, oui : c'est le
/// comportement d'avant, qui relance le maître.
async fn has_remote(repo: &str) -> bool {
	git::run_git(std::path::Path::new(repo), &["remote"])
		.await
		.map(|out| !out.trim().is_empty())
		.unwrap_or(true)
}

pub(crate) async fn revive_integration(app: &AppHandle, mission: &mission::Mission) {
	use tauri::Manager;
	if mission::idle_seconds(mission) < INTEGRATION_STALL_SECONDS {
		return;
	}
	if let Some(agents) = app.try_state::<agent::SharedAgents>() {
		if let Some(session) = &mission.master_session {
			if agent::is_working(agents.inner(), session) {
				return;
			}
		}
	}

	// Une relance qui ne fait rien avancer se répète toutes les quatre minutes,
	// indéfiniment — constaté sur une mission dont la pull request ne pouvait
	// pas s'ouvrir (pas de forge) : chaque maître relancé relisait tout,
	// échouait au même endroit, et coûtait un tour complet. Passé
	// `MAX_FRUITLESS_REVIVALS` relances sans le moindre progrès, la mission se
	// met en pause et dit pourquoi : c'est un humain qu'il faut, pas un maître
	// de plus.
	if !mission::note_revival(
		&mission.id,
		&mission::progress_fingerprint(mission),
		MAX_FRUITLESS_REVIVALS,
	) {
		if mission::set_paused(&mission.id, true).is_ok() {
			journal::record(
				"mission",
				&i18n::t("lib.mission.revivalsExhausted"),
				&mission.title,
				false,
				&i18n::tf(
					"lib.mission.revivalsExhaustedDetail",
					&[("count", &MAX_FRUITLESS_REVIVALS)],
				),
			);
		}
		return;
	}

	// Tout est intégré et le dépôt n'a pas de remote : aucune pull request ne
	// peut s'ouvrir, et un maître relancé échouerait au même endroit, trois fois,
	// avant la pause. On s'arrête tout de suite et on dit quoi faire : la
	// mission se termine en local, d'un bouton.
	if mission::unintegrated(mission).is_empty() && !has_remote(&mission.cwd).await {
		if mission::set_paused(&mission.id, true).is_ok() {
			journal::record(
				"mission",
				&i18n::t("lib.mission.noRemote"),
				&mission.title,
				false,
				&i18n::t("lib.mission.noRemoteDetail"),
			);
		}
		return;
	}

	journal::record(
		"mission",
		&i18n::t("lib.mission.integrationResumed"),
		&mission.title,
		true,
		&i18n::t("lib.mission.integrationResumedDetail"),
	);
	let brief = format!(
		"You are taking over the mission \"{}\" at integration: it has not moved for \
		 a while and nobody was holding it.\n\n\
		 Start with `status` to see where the tasks stand, then `integrate` — merging \
		 an already merged branch costs nothing, and it is the only way to know what \
		 is still outside. Open the pull request once everything is recombined; if a \
		 conflict stops you, say so and stop there.",
		mission.title,
	);
	if let Err(error) = launch_master(
		app.clone(),
		mission.id.clone(),
		Some(brief),
		executions::Origin::cockpit(config::MASTER_ROLE),
	)
	.await
	{
		journal::record(
			"mission",
			&i18n::t("lib.mission.integrationNotResumed"),
			&mission.title,
			false,
			&error.to_string(),
		);
	}
}

pub(crate) fn watch_missions(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		let mut tours: u64 = 0;
		loop {
			tokio::time::sleep(std::time::Duration::from_secs(6)).await;
			reap_stray_agents(&app);
			// La dépense se relit toutes les minutes, pas toutes les six
			// secondes : elle demande de parcourir les journaux de toutes les
			// sessions, et une mission ne dérape pas en six secondes.
			tours += 1;
			if tours.is_multiple_of(10) {
				pause_missions_hors_budget();
			}
			for mission in mission::list() {
				if mission.paused {
					continue;
				}
				// L'intégration se surveille comme le reste. Elle ne l'était pas :
				// une fois la mission passée en `Integrating`, cette boucle la
				// sautait, et si le maître mourait, terminait son tour sans ouvrir
				// la pull request, ou n'avait jamais démarré, la mission restait là
				// des heures sans que rien ne la reprenne ni ne le dise.
				if mission.state == mission::MissionState::Integrating {
					revive_integration(&app, &mission).await;
					continue;
				}
				if mission.state != mission::MissionState::Running {
					continue;
				}
				// Constater avant de lancer : une tâche qui vient de finir peut
				// libérer la recette, qui partira dans la foulée.
				collect_finished_tasks(&app, &mission.id).await;
				launch_ready_tasks(app.clone(), &mission.id).await;
				move_to_integration(&app, &mission.id).await;
			}
		}
	});
}

/// Traite les appels que le maître dépose par son pont MCP.
///
/// Une boucle plutôt qu'un serveur : le maître écrit un fichier, le cockpit
/// répond par un autre. Un agent tué en plein appel ne laisse qu'un fichier
/// orphelin, là où un socket coupé laisserait les deux côtés à s'attendre.
/// Le regard de la Permanence, à la cadence déclarée.
///
/// La boucle tourne toujours ; ce sont ses portes qui décident, et elles sont
/// dans `permanence::look`. C'est délibéré : une boucle qu'on n'aurait pas
/// lancée parce que le service était éteint au démarrage ne repartirait pas
/// quand on l'allume, et il faudrait redémarrer le cockpit pour s'en servir.
///
/// La cadence se relit à chaque tour plutôt qu'au lancement, pour la même
/// raison : un réglage qui n'a d'effet qu'au prochain démarrage n'est pas un
/// réglage, c'est une option de compilation.
pub(crate) fn watch_permanence(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		loop {
			let minutes = cfg().permanence.cadence();
			tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;
			if let Err(error) = permanence::look(None, Some(app.clone())).await {
				eprintln!("permanence : {error}");
			}
		}
	});
}

pub(crate) fn watch_orchestrator(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		loop {
			tokio::time::sleep(std::time::Duration::from_millis(300)).await;
			for call in orchestrator::pending() {
				orchestrator::handle(&app, call).await;
			}
		}
	});
}

/// Refuse les écritures qui sortent du périmètre d'une tâche.
///
/// Le pont d'autorisation dépose chaque demande sur le disque avant de
/// l'afficher : on l'examine ici, en amont. Une consigne de périmètre écrite
/// dans un prompt tient tant que le modèle y pense ; celle-ci ne dépend plus
/// de lui, et l'exécutant reçoit un refus motivé plutôt qu'un silence.
///
/// Seules les écritures de fichiers sont jugées : deviner ce qu'une ligne de
/// commande va toucher serait une promesse qu'on ne peut pas tenir, et un
/// refus faux vaut moins qu'une question posée à l'humain.
pub(crate) fn watch_scopes() {
	tauri::async_runtime::spawn(async move {
		loop {
			tokio::time::sleep(std::time::Duration::from_millis(400)).await;
			for request in permissions::pending() {
				let Some(session) = request.session_id.as_deref() else {
					continue;
				};
				// Un agent de revue lit, il n'écrit pas : tout ce qui n'est pas
				// une lecture autorisée d'office arrive ici, et repart refusé.
				// Une question à la personne, elle, passe.
				if review::is_readonly(session) && request.tool != "AskUserQuestion" {
					let reason = format!(
						"Read-only review: \"{}\" is not allowed. Review without modifying anything, \
						 with `git diff`, `git log`, `git show` or by reading the files.",
						request.tool
					);
					let _ = permissions::answer(&request.id, false, Some(reason));
					continue;
				}
				let Some((task, root, scope)) = mission::scope_of(session) else {
					continue;
				};
				let outside: Vec<String> = mission::written_paths(&request.tool, &request.input)
					.into_iter()
					.filter(|path| !mission::within_scope_at(&root, &scope, path))
					.collect();
				if outside.is_empty() {
					continue;
				}
				let reason = format!(
					"Outside the scope of \"{task}\": {}. Allowed paths: {}. \
					 If this file needs to change, report it instead of modifying it.",
					outside.join(", "),
					scope.join(", ")
				);
				let _ = permissions::answer(&request.id, false, Some(reason));
				journal::record(
					"mission",
					&i18n::t("lib.mission.outOfScopeRefused"),
					&outside.join(", "),
					false,
					&task,
				);
			}
		}
	});
}

/// Surveille `~/.claude/projects` et notifie l'UI dès qu'un agent écrit.
/// Debounce volontaire : Claude Code écrit par rafales, on ne veut pas
/// re-scanner à chaque ligne de JSONL.
pub(crate) fn watch_sessions(app: AppHandle) {
	use notify::{RecursiveMode, Watcher};

	std::thread::spawn(move || {
		let (tx, rx) = std::sync::mpsc::channel();
		let mut watcher = match notify::recommended_watcher(tx) {
			Ok(watcher) => watcher,
			Err(_) => return,
		};

		// Un compte par racine : surveiller la seule racine du compte actif
		// aurait figé l'écran des sessions dès qu'un agent travaille sous une
		// autre identité. Un dossier qui n'existe pas encore — un compte déclaré
		// mais jamais utilisé — n'empêche pas de surveiller les autres.
		let mut surveillées = 0;
		for root in sessions::projects_roots() {
			if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
				surveillées += 1;
			}
		}
		if surveillées == 0 {
			return;
		}

		let mut pending = false;
		let mut last_emit = std::time::Instant::now();
		loop {
			match rx.recv_timeout(std::time::Duration::from_millis(700)) {
				Ok(Ok(_)) => pending = true,
				Ok(Err(_)) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
			}

			if pending && last_emit.elapsed() >= std::time::Duration::from_millis(1500) {
				pending = false;
				last_emit = std::time::Instant::now();
				let _ = app.emit("sessions://changed", ());
			}
		}
	});
}

/// Un mouvement dans `.git` qui change vraiment ce que l'UI affiche.
///
/// Lire l'état d'un dépôt le modifie : `git status` rafraîchit le cache de
/// `stat` dans `.git/index`, ce qui réveille le watcher, ce qui relance une
/// lecture — la boucle tient toute seule et fait vibrer l'écran en continu. On
/// ne retient donc que les refs, HEAD et les worktrees, c'est-à-dire ce qu'un
/// commit, un checkout ou un merge déplacent réellement.
pub(crate) fn is_meaningful_git_change(path: &Path) -> bool {
	let text = path.to_string_lossy();

	// Fichiers de travail internes : bruit pur.
	if text.ends_with(".lock") || text.contains("/objects/") || text.ends_with("FETCH_HEAD") {
		return false;
	}

	text.contains("/refs/")
		|| text.contains("/worktrees/")
		|| text.ends_with("/HEAD")
		|| text.ends_with("MERGE_HEAD")
		|| text.ends_with("packed-refs")
}

/// Surveille le `.git` du dépôt principal et notifie l'UI à chaque mouvement
/// (commit, checkout, création de worktree).
///
/// C'est volontairement le dossier `.git` et non l'arbre de travail : celui-ci
/// contient `node_modules` et les artefacts de build, dont les rafales
/// noieraient le signal. Les métadonnées des worktrees vivant sous
/// `.git/worktrees/`, une seule surveillance récursive les couvre tous.
pub(crate) fn watch_git(app: AppHandle) {
	use notify::{RecursiveMode, Watcher};

	std::thread::spawn(move || {
		let git_dir = PathBuf::from(&cfg().general.main_repo).join(".git");
		if !git_dir.exists() {
			return;
		}

		let (tx, rx) = std::sync::mpsc::channel();
		let mut watcher = match notify::recommended_watcher(tx) {
			Ok(watcher) => watcher,
			Err(_) => return,
		};
		if watcher.watch(&git_dir, RecursiveMode::Recursive).is_err() {
			return;
		}

		let mut pending = false;
		let mut last_emit = std::time::Instant::now();
		loop {
			match rx.recv_timeout(std::time::Duration::from_millis(700)) {
				Ok(Ok(event)) => {
					if event.paths.iter().any(|path| is_meaningful_git_change(path)) {
						pending = true;
					}
				}
				Ok(Err(_)) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
			}

			if pending && last_emit.elapsed() >= std::time::Duration::from_secs(2) {
				pending = false;
				last_emit = std::time::Instant::now();
				let _ = app.emit("git://changed", ());
			}
		}
	});
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Relève le plafond de fichiers ouverts du processus.
///
/// Lancé depuis le Finder, le cockpit hérite du plafond par défaut de
/// launchd — 256, vérifié via `launchctl limit maxfiles` sur ce poste —
/// largement insuffisant dès que plusieurs missions tournent en parallèle :
/// chaque conteneur isolé ouvre plusieurs volumes, pipes et processus
/// enfants, et un agent de plus finissait par refuser de démarrer sur
/// « Too many open files (os error 24) ». La limite dure (`unlimited` ici)
/// autorise bien plus haut ; il suffit de le demander au noyau.
#[cfg(unix)]
pub(crate) fn raise_file_descriptor_limit() {
	// Sûr : `rlimit` est un struct C simple (deux entiers), sans invariant
	// à préserver au-delà de ce que `getrlimit`/`setrlimit` documentent.
	unsafe {
		let mut limit = libc::rlimit {
			rlim_cur: 0,
			rlim_max: 0,
		};
		if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
			return;
		}
		let souhaite = (10_240u64).min(limit.rlim_max);
		if souhaite > limit.rlim_cur {
			limit.rlim_cur = souhaite as libc::rlim_t;
			let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
		}
	}
}

#[cfg(not(unix))]
pub(crate) fn raise_file_descriptor_limit() {}

#[cfg(all(test, unix))]
mod file_descriptor_limit_tests {
	use super::raise_file_descriptor_limit;

	/// Sur le vrai noyau de la machine qui fait tourner ce test, pas une
	/// hypothèse sur `libc` : le plafond effectif doit vraiment monter.
	#[test]
	fn releve_vraiment_le_plafond_du_processus() {
		let lire = || unsafe {
			let mut limit = libc::rlimit {
				rlim_cur: 0,
				rlim_max: 0,
			};
			libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
			limit
		};

		// Redescendu d'abord : un run précédent, ou l'environnement de test
		// lui-même, peut déjà être large — sans ça, ce test ne prouverait
		// rien de plus qu'un plafond déjà confortable.
		let avant = lire();
		unsafe {
			let bas = libc::rlimit {
				rlim_cur: 64,
				rlim_max: avant.rlim_max,
			};
			libc::setrlimit(libc::RLIMIT_NOFILE, &bas);
		}
		assert_eq!(lire().rlim_cur, 64);

		raise_file_descriptor_limit();

		let apres = lire();
		assert!(apres.rlim_cur > 64, "le plafond n'a pas bougé : {}", apres.rlim_cur);
	}
}
