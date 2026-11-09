//! Les commandes IPC des missions, et ce qui les fait avancer.
//!
//! Sorti tel quel de `lib.rs`, qui dépassait 5 800 lignes : un ticket, un plan,
//! des exécutants, leur ramassage et leur intégration. Le module voit tout ce
//! que voit la racine (`use super::*`) ; ce que la racine lui emprunte est
//! `pub(crate)`. L'état et ses règles vivent dans `mission.rs`, les outils du
//! maître dans `orchestrator.rs` : ce module-ci les branche à l'app.

use super::*;

/// Ce qu'un découpage de `taskCount` tâches coûtera, d'après les missions
/// closes de taille voisine. Sert au moment d'approuver un plan : c'est le seul
/// instant où l'on peut encore décider de ne pas le lancer.
#[tauri::command(async)]
pub(crate) fn mission_estimate(task_count: usize) -> mission::Estimate {
	mission::estimate(task_count)
}

/// Les tâches qui débordent de ce qu'une tâche coûte d'ordinaire.
///
/// Rien n'est coupé : une tâche longue peut être une tâche difficile, et le
/// cockpit n'a pas de quoi trancher. Il dit ce qu'il voit, et laisse la
/// décision — reprendre, redécouper, arrêter — à qui pilote.
#[tauri::command(async)]
pub(crate) fn mission_overruns() -> Vec<mission::Overrun> {
	mission::all_overruns()
}

/// Toutes les missions, tous projets confondus.
///
/// Pour la carte, qui montre chaque projet comme une île sans changer de projet
/// actif : c'est l'écran qui les range sous le dépôt de chacun (`Mission.cwd`).
#[tauri::command(async)]
pub(crate) fn missions_everywhere() -> Vec<mission::Mission> {
	mission::list()
}

#[tauri::command(async)]
pub(crate) fn missions_list() -> Vec<mission::Mission> {
	// Les missions du projet affiché, et elles seules : une mission ouverte sur
	// un dépôt n'a rien à faire dans l'écran d'un autre. Le lanceur, lui,
	// continue de les voir toutes — il fait avancer ce qui tourne, quel que soit
	// le projet qu'on regarde.
	let repo = cfg().general.main_repo;
	mission::list()
		.into_iter()
		.filter(|mission| mission.belongs_to(&repo))
		.collect()
}

#[tauri::command(async)]
pub(crate) fn mission_get(id: String) -> Result<mission::Mission> {
	mission::get(&id)
}

#[tauri::command]
pub(crate) fn mission_create(
	title: String,
	ticket: Option<String>,
	ticket_url: Option<String>,
	cwd: Option<String>,
	branch: Option<String>,
) -> Result<mission::Mission> {
	mission::create(
		&title,
		&ticket.unwrap_or_default(),
		&ticket_url.unwrap_or_default(),
		&cwd.unwrap_or_else(|| cfg().general.main_repo.clone()),
		&branch.unwrap_or_default(),
		!cfg().missions.autonomous,
	)
}

/// Le nécessaire pour ouvrir une mission depuis un ticket, et le ticket
/// lui-même — `mission_start_from_ticket` s'en sert pour donner au maître ce
/// qu'il sait déjà, sans lui faire redemander la même chose par MCP.
pub(crate) async fn create_mission_from_ticket(reference: &str) -> Result<(mission::Mission, tickets::TicketDetail)> {
	let config = cfg();
	let identifier = mission::ticket_reference(reference);
	if identifier.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.mission.ticketReferenceRequired")));
	}

	let ticket = tickets::provider(&config)?.get(&identifier).await?;
	let branch = if ticket.branch_name.trim().is_empty() {
		mission::branch_from(&ticket.identifier, &ticket.title)
	} else {
		ticket.branch_name.clone()
	};

	let mission = mission::create(
		&ticket.title,
		&ticket.identifier,
		&ticket.url,
		&config.general.main_repo,
		&branch,
		!config.missions.autonomous,
	)?;
	Ok((mission, ticket))
}

/// Ouvre une mission à partir d'un ticket : une URL collée suffit.
///
/// Le titre, l'identifiant et la branche viennent du suivi de tâches. Les
/// redemander à quelqu'un qui a déjà le ticket sous les yeux, c'est lui faire
/// recopier ce que la machine sait lire.
#[tauri::command]
pub(crate) async fn mission_from_ticket(reference: String) -> Result<mission::Mission> {
	create_mission_from_ticket(&reference).await.map(|(mission, _)| mission)
}

/// Ce que le ticket dit déjà, mis en forme pour le premier prompt du maître.
///
/// Sans ça, le maître ne recevait que le titre et l'URL — le reste, il devait
/// aller le chercher lui-même par un outil MCP Linear/GitHub. Un agent isolé
/// n'en a pas forcément (identité séparée du poste, voir `sandbox.rs`) : il
/// restait bloqué sur « je n'ai pas accès à Linear » avant même de commencer,
/// alors que le cockpit avait déjà tout lu pour ouvrir la mission.
pub(crate) fn ticket_brief(ticket: &tickets::TicketDetail) -> String {
	let mut brief = String::new();
	if !ticket.description.trim().is_empty() {
		brief.push_str(&format!(
			"── The ticket, as read when the mission was opened ──\n{}",
			ticket.description.trim()
		));
	}
	if !ticket.comments.is_empty() {
		if !brief.is_empty() {
			brief.push_str("\n\n");
		}
		brief.push_str("── Comments, oldest to newest ──\n");
		for comment in ticket.comments.iter().rev().take(5).rev() {
			brief.push_str(&format!("- {}: {}\n", comment.author, comment.body.trim()));
		}
	}
	brief
}

#[cfg(test)]
mod ticket_brief_tests {
	use super::*;

	fn ticket(description: &str, comments: Vec<(&str, &str)>) -> tickets::TicketDetail {
		tickets::TicketDetail {
			id: "1".into(),
			identifier: "NW-1".into(),
			title: "Titre".into(),
			description: description.into(),
			url: String::new(),
			priority: 0,
			estimate: None,
			branch_name: String::new(),
			updated_at: String::new(),
			state: None,
			assignee: None,
			labels: Vec::new(),
			comments: comments
				.into_iter()
				.map(|(author, body)| integrations::LinearComment {
					id: String::new(),
					body: body.into(),
					author: author.into(),
					created_at: String::new(),
				})
				.collect(),
		}
	}

	#[test]
	fn un_ticket_sans_rien_rend_un_brief_vide() {
		assert_eq!(ticket_brief(&ticket("", vec![])), "");
	}

	#[test]
	fn la_description_se_retrouve_dans_le_brief() {
		let brief = ticket_brief(&ticket("Le bouton ne répond plus au double clic.", vec![]));
		assert!(brief.contains("Le bouton ne répond plus au double clic."));
	}

	#[test]
	fn les_commentaires_recents_accompagnent_la_description() {
		let brief = ticket_brief(&ticket(
			"Description.",
			vec![("Frank", "Vu en prod hier soir."), ("Alice", "Confirmé, je regarde.")],
		));
		assert!(brief.contains("Frank"));
		assert!(brief.contains("Vu en prod hier soir."));
		assert!(brief.contains("Alice"));
	}
}

/// Ce que fabriquent le maître et les exécutants, en ce moment même.
///
/// Une mission qui affiche « maître actif » sans rien d'autre ne dit pas si
/// l'agent réfléchit, s'il attend une autorisation ou s'il a fini depuis dix
/// minutes. C'est cette information-là qu'on regarde, pas l'état stocké.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivity {
	session_id: String,
	/// Le processus tourne encore.
	running: bool,
	/// Il a écrit dans les dernières secondes.
	working: bool,
	/// Sa dernière phrase, ou le dernier outil appelé.
	last: String,
	/// Nombre de demandes d'autorisation en attente pour cet agent.
	waiting: usize,
}

#[tauri::command(async)]
pub(crate) fn mission_activity(app: AppHandle, id: String) -> Result<serde_json::Value> {
	use tauri::Manager;
	let mission = mission::get(&id)?;
	let agents = app
		.try_state::<agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default();
	let pending = permissions::pending();

	let activity = |session: Option<&str>| -> Option<AgentActivity> {
		let session = session?;
		let status = agents.iter().find(|entry| entry.session_id == session);
		let claude = status.and_then(|entry| entry.claude_session_id.clone());
		let file = claude.as_deref().and_then(remote::session_file);

		let (last, working) = match file.as_deref() {
			Some(path) => {
				let events = sessions::read_timeline(std::path::Path::new(path), 200).unwrap_or_default();
				let last = events
					.iter()
					.rev()
					.find(|event| !event.text.trim().is_empty())
					.map(|event| event.text.chars().take(200).collect::<String>())
					.unwrap_or_default();
				(last, remote::recently_active(path))
			}
			// Aucune session Claude capturée : soit l'agent tourne encore sans
			// avoir répondu, soit il est mort avant d'y arriver — auquel cas ce
			// même instant a versé pourquoi au journal (voir `agent::spawn_reader`).
			// Sans ça, un maître qui meurt en silence n'affiche jamais que
			// « arrêté », sans un mot de plus à qui regarde après coup.
			None => {
				// Le titre traduit d'aujourd'hui, ou l'ancien libellé français
				// des entrées écrites avant la traduction.
				let died = i18n::t("agent.journal.diedBeforeFirstAnswer");
				let cause = journal::list(200)
					.into_iter()
					.find(|entry| {
						entry.kind == "agent"
							&& entry.target == session
							&& (entry.label == died || entry.label == "Agent arrêté avant sa première réponse")
					})
					.map(|entry| entry.detail);
				(cause.unwrap_or_default(), false)
			}
		};

		Some(AgentActivity {
			session_id: session.to_string(),
			running: status.map(|entry| entry.running).unwrap_or(false),
			working,
			last,
			waiting: pending
				.iter()
				.filter(|request| request.session_id.as_deref() == Some(session))
				.count(),
		})
	};

	Ok(serde_json::json!({
		"master": activity(mission.master_session.as_deref()),
		"tasks": mission
			.tasks
			.iter()
			.filter_map(|task| {
				let entry = activity(task.session_id.as_deref())?;
				Some(serde_json::json!({ "taskId": task.id, "activity": entry }))
			})
			.collect::<Vec<_>>(),
	}))
}

/// Fil complet d'un agent, quel que soit qui l'a lancé.
///
/// L'interface tient l'historique des agents qu'elle a démarrés elle-même. Ceux
/// que le cockpit lance de son côté — le maître d'une mission, ses exécutants —
/// lui étaient inconnus : elle les affichait comme des onglets vides, quand
/// elle les affichait. Elle peut désormais adopter leur conversation.
#[tauri::command(async)]
pub(crate) fn agent_timeline(session_id: String, app: AppHandle) -> Result<Vec<sessions::SessionEvent>> {
	use tauri::Manager;
	let claude = app
		.try_state::<agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default()
		.into_iter()
		.find(|status| status.session_id == session_id)
		.and_then(|status| status.claude_session_id);

	timeline_of(&session_id, claude.as_deref())
}

/// Le choix de la source, isolé de l'état de l'application.
///
/// `claude_session` est la conversation Claude Code de cet agent, quand le
/// registre la connaît encore — il ne la connaît plus une fois le cockpit
/// redémarré, et c'est précisément le cas qui rend le relevé utile.
///
/// Détaché de la commande pour être éprouvé pour de vrai : une recette qui
/// réimplémenterait ce choix ne prouverait que sa propre copie.
pub fn timeline_of(session_id: &str, claude_session: Option<&str>) -> Result<Vec<sessions::SessionEvent>> {
	// Le journal de Claude Code d'abord, quand il existe : c'est la source la
	// plus riche, et la seule à porter les sous-agents.
	if let Some(file) = claude_session.and_then(remote::session_file) {
		return sessions::read_timeline(std::path::Path::new(&file), 400);
	}

	// Sinon le relevé du cockpit. C'est ce qui donne un historique aux moteurs
	// qui n'en laissent aucun sur le disque — Codex, dont le format de session
	// n'est pas documenté de façon vérifiable, et Gemini, qui n'en écrit pas.
	// Jusqu'ici cet écran leur répondait par une conversation vide dès que le
	// cockpit avait été fermé.
	//
	// La dernière exécution de cette session, et non leur somme : un agent par
	// tour en ouvre une seule, et deux exécutions sur une même session seraient
	// deux conversations distinctes qu'on n'a aucune raison de recoller.
	let Some(execution) = executions::for_session(session_id).pop() else {
		return Ok(Vec::new());
	};
	Ok(executions::timeline_as_events(&execution.id))
}

#[tauri::command]
pub(crate) fn mission_remove(id: String) -> Result<()> {
	mission::remove(&id)
}

/// Déclare la branche sur laquelle la pull request finale se greffera.
///
/// Une mission qui prolonge un travail encore en revue ne doit pas viser la
/// branche par défaut : sa PR y montrerait aussi ce que la précédente contient
/// déjà. Empilée sur la branche parente, elle ne montre que ce qu'elle ajoute —
/// et la forge affiche la dépendance entre les deux.
#[tauri::command]
pub(crate) fn mission_set_base(id: String, base: String) -> Result<mission::Mission> {
	mission::set_base(&id, &base)
}

/// Relance une tâche en lui faisant tout reprendre depuis le début.
///
/// Une vérification garde en mémoire ce qu'elle a déjà lu, et ne rejuge ensuite
/// que les changements — c'est ce qui rend les reprises rapides. Encore
/// faut-il pouvoir dire « recommence tout » : après un correctif qui touche à
/// l'architecture, un verdict rendu sur l'ancien code ne vaut plus rien.
#[tauri::command]
pub(crate) async fn mission_task_rerun(app: AppHandle, id: String, task_id: String) -> Result<String> {
	use tauri::Manager;
	let mission = mission::get(&id)?;
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.unknownTask")))?;

	// L'agent en place travaille sur l'ancienne consigne : on le coupe avant
	// d'en lancer un autre, sinon les deux écrivent au même endroit.
	if let (Some(agents), Some(session)) = (app.try_state::<agent::SharedAgents>(), task.session_id.as_ref()) {
		let _ = agent::stop(agents.inner(), session);
	}

	mission::set_checkpoint(&id, &task_id, "")?;
	mission::set_task_state(
		&id,
		&task_id,
		mission::TaskState::Planned,
		&i18n::t("lib.mission.fullReviewRequested"),
	)?;
	launch_task_agent(app, &id, &task_id, journal::HUMAN).await
}

/// Efface la mission et tout ce qu'elle a créé. Sans retour possible.
#[tauri::command]
pub(crate) async fn mission_purge(app: AppHandle, id: String) -> Result<Vec<String>> {
	stop_mission_agents(&app, &id);
	mission::purge(&id).await
}

/// Coupe tous les agents d'une mission — le maître et ses exécutants.
///
/// Arrêter les processus ne suffit pas : une tâche laissée « en cours » ne
/// serait plus jamais reprise par le lanceur, qui ne regarde que ce qui reste à
/// faire. On la remet donc à faire, son worktree et son travail intacts.
pub(crate) fn stop_mission_agents(app: &AppHandle, id: &str) -> usize {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else {
		return 0;
	};
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return 0;
	};
	let agents = agents.inner().clone();

	let mut stopped = 0;
	if let Some(session) = &mission.master_session {
		let _ = agent::stop(&agents, session);
		stopped += 1;
	}
	for task in &mission.tasks {
		if let Some(session) = &task.session_id {
			let _ = agent::stop(&agents, session);
			stopped += 1;
		}
		if task.state == mission::TaskState::Running {
			let _ = mission::set_task_state(
				id,
				&task.id,
				mission::TaskState::Planned,
				&i18n::t("lib.mission.workerStopped"),
			);
		}
	}
	let _ = mission::update_master_session(id, None);
	stopped
}

/// Suspend une mission : plus rien ne part, les agents en cours sont coupés.
#[tauri::command]
pub(crate) fn mission_pause(app: AppHandle, id: String) -> Result<mission::Mission> {
	stop_mission_agents(&app, &id);
	mission::set_paused(&id, true)
}

/// Ce qu'un maître doit savoir en reprenant une mission déjà en route.
///
/// Sans ce rappel, le prompt de lancement le remet au premier jour : il lit le
/// ticket, propose un découpage — alors que son plan est approuvé et que ses
/// exécutants travaillent depuis une heure. On lui dit donc où en est la
/// mission, et surtout de constater avant d'agir.
pub(crate) fn resume_brief(mission: &mission::Mission) -> String {
	let taches = mission
		.tasks
		.iter()
		.map(|task| {
			format!(
				"- `{}` {} — {:?}{}",
				task.role,
				task.title,
				task.state,
				if task.note.trim().is_empty() {
					String::new()
				} else {
					format!(" ({})", task.note.trim())
				}
			)
		})
		.collect::<Vec<_>>()
		.join("\n");

	format!(
		"── Resuming ──\n\
		 This mission was already under way: Cockpit restarted, not the mission. Its \
		 state is `{:?}`{}.\n\n\
		 {}\n\n\
		 Start with `status` to see the mission as it is now, and carry on from there. \
		 Do not re-plan what is already broken down, and do not relaunch what is \
		 running: Cockpit restarts the pending tasks by itself.",
		mission.state,
		if mission.plan.trim().is_empty() {
			""
		} else {
			", its plan is set"
		},
		if taches.is_empty() {
			"No task has been created yet.".to_string()
		} else {
			format!("Its tasks, as last known:\n{taches}")
		},
	)
}

/// Reprend une mission suspendue, et relance d'un coup ce qui doit tourner.
#[tauri::command]
pub(crate) async fn mission_resume(app: AppHandle, id: String) -> Result<mission::Mission> {
	mission::set_paused(&id, false)?;
	// Un maître absent n'empêche pas les exécutants de repartir, mais c'est lui
	// qui recompose à la fin : on le remet debout tant qu'on y est.
	let mission = mission::get(&id)?;
	if mission.master_session.is_none() && mission.state != mission::MissionState::Done {
		let brief = resume_brief(&mission);
		let _ = launch_master(app.clone(), id.clone(), Some(brief), executions::Origin::human()).await;
	}
	launch_ready_tasks(app, &id).await;
	mission::get(&id)
}

/// La consigne d'un rôle, avec la forme de son verdict quand il en rend un.
///
/// Cette forme n'était écrite que dans les rôles par défaut. Un rôle `verifies` à la
/// consigne maison n'en savait rien : vu sur une vraie mission, sa relecture finit sur
/// « Approved », le cockpit lit `undecided`, et la tâche repart pour rien. C'est un
/// contrat du cockpit, pas une préférence d'équipe.
fn prompt_with_verdict(role: &config::RoleConfig) -> String {
	if !role.verifies || role.prompt.contains("VERDICT:") {
		return role.prompt.clone();
	}
	format!(
		"{}\n\n\
		 End with a verdict on a single line (keep these markers in English exactly): \
		 `VERDICT: blocking`, `VERDICT: concerns` or `VERDICT: ok`. Under it, list what \
		 must be fixed, one item per line, naming the file and what is wrong.",
		role.prompt.trim_end()
	)
}

/// Remet debout les maîtres des missions qu'un redémarrage a décapitées.
///
/// `recover_all` rend leurs tâches reprenables et le lanceur les fait repartir :
/// les exécutants revenaient donc seuls, sans personne pour lire leurs verdicts
/// ni recomposer à la fin. La mission avançait en apparence et s'arrêtait à
/// l'intégration, sans que rien ne dise ce qui manquait.
///
/// Une mission en pause reste en pause : c'est un geste explicite, et le
/// redémarrage n'a pas à le défaire.
pub(crate) async fn relaunch_mission_masters(app: &AppHandle) -> usize {
	let mut relancés = 0;
	for mission in mission::list() {
		if mission.paused || mission.master_session.is_some() {
			continue;
		}
		if matches!(
			mission.state,
			mission::MissionState::Done | mission::MissionState::Failed
		) {
			continue;
		}
		let brief = resume_brief(&mission);
		if launch_master(
			app.clone(),
			mission.id.clone(),
			Some(brief),
			executions::Origin::cockpit(config::MASTER_ROLE),
		)
		.await
		.is_ok()
		{
			relancés += 1;
		}
	}
	relancés
}

/// Coupe tout et abandonne la mission — le travail déjà produit reste en place.
#[tauri::command]
pub(crate) fn mission_stop(app: AppHandle, id: String) -> Result<mission::Mission> {
	stop_mission_agents(&app, &id);
	mission::set_paused(&id, true)?;
	mission::set_state(&id, mission::MissionState::Failed, &i18n::t("lib.mission.stopped"))
}

/// Enregistre un plan et le met en attente d'approbation.
#[tauri::command]
pub(crate) fn mission_plan(id: String, plan: String, tasks: Vec<mission::Task>) -> Result<mission::Mission> {
	mission::submit_plan(&id, &plan, tasks)
}

#[tauri::command]
pub(crate) async fn mission_approve(app: AppHandle, id: String) -> Result<mission::Mission> {
	let mission = mission::approve(&id)?;
	// Le feu vert vaut lancement : on ne fait pas cliquer une seconde fois.
	launch_ready_tasks(app, &id).await;
	mission::get(&mission.id)
}

#[tauri::command]
pub(crate) fn mission_state(
	id: String,
	state: mission::MissionState,
	note: Option<String>,
) -> Result<mission::Mission> {
	mission::set_state(&id, state, &note.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn mission_task_add(id: String, task: mission::Task) -> Result<mission::Mission> {
	mission::add_task(&id, task)
}

#[tauri::command]
pub(crate) fn mission_task_state(
	id: String,
	task_id: String,
	state: mission::TaskState,
	note: Option<String>,
) -> Result<mission::Mission> {
	mission::set_task_state(&id, &task_id, state, &note.unwrap_or_default())
}

/// Rattache un agent en cours à une tâche — ou au maître si `taskId` est vide.
#[tauri::command]
pub(crate) fn mission_attach(id: String, task_id: String, session_id: String) -> Result<mission::Mission> {
	if task_id.trim().is_empty() {
		mission::attach_master(&id, &session_id)
	} else {
		mission::attach_task(&id, &task_id, &session_id)
	}
}

/// Lance l'exécutant d'une tâche, avec la consigne de son rôle.
///
/// Le prompt se compose ici plutôt que dans l'interface : il porte le contrat
/// de la tâche — sa mission, sa branche d'intégration, son périmètre — et ce
/// contrat ne doit pas dépendre de ce qu'un écran a bien voulu recopier.
#[tauri::command]
pub(crate) async fn mission_task_launch(
	app: AppHandle,
	agents: State<'_, agent::SharedAgents>,
	id: String,
	task_id: String,
) -> Result<String> {
	let _ = agents;
	launch_task_agent(app, &id, &task_id, journal::HUMAN).await
}

/// Lancement d'un exécutant, appelé aussi bien par l'interface que par le
/// maître : un seul chemin, donc un seul prompt et une seule politique.
///
/// `actor` dit qui l'a demandé — [`executions::MASTER`] quand c'est le maître de
/// la mission, [`journal::HUMAN`] pour un geste dans l'interface,
/// [`executions::COCKPIT`] pour une boucle qui lance ce qui est devenu prêt. Le
/// rôle, la tâche et le numéro de tentative, eux, se lisent sur la tâche.
pub async fn launch_task_agent(app: AppHandle, id: &str, task_id: &str, actor: &str) -> Result<String> {
	use tauri::Manager;
	let agents = app
		.try_state::<agent::SharedAgents>()
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.agentsUnavailable")))?
		.inner()
		.clone();
	let id = id.to_string();
	let task_id = task_id.to_string();
	let mission = mission::get(&id)?;
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.unknownTask")))?
		.clone();

	if !mission.can_launch() {
		return Err(CockpitError::msg(i18n::t("lib.mission.awaitingAgreement")));
	}

	// Le catalogue du projet de la mission, pas celui de l'écran affiché : les
	// missions tournent en fond, souvent devant l'onglet d'un autre produit, et
	// c'est ainsi qu'une recette partait sans la commande `/self-qa` de son
	// équipe.
	let role = role_config(&mission.cwd, &task.role)
		.ok_or_else(|| CockpitError::msg(i18n::tf("lib.mission.unknownRole", &[("role", &task.role)])))?;

	// Sans worktree, on ne lance pas. Le repli d'avant envoyait l'exécutant dans
	// `mission.cwd` — le dépôt principal, celui où l'utilisateur a sa propre
	// branche sortie — avec pour consigne de commiter son travail. Les commits
	// de la mission atterrissaient donc dans son `dev` local, mêlés aux siens,
	// et le worktree principal devenait un chantier. Mieux vaut préparer le
	// terrain, ou refuser en le disant.
	let cwd = if task.worktree.trim().is_empty() {
		match orchestrator::prepare_worktree(&mission, &task).await {
			Ok(worktree) => {
				mission::set_task_worktree(&mission.id, &task.id, &worktree)?;
				worktree
			}
			Err(error) => {
				let raison = i18n::tf("lib.mission.workerWorktreeFailed", &[("error", &error)]);
				let _ = mission::set_task_state(&mission.id, &task.id, mission::TaskState::Failed, &raison);
				return Err(CockpitError::msg(raison));
			}
		}
	} else {
		task.worktree.clone()
	};

	// Une tâche qui vérifie ne voit sinon aucune de ses sœurs : rien d'autre
	// que l'intégration finale ne fusionne quoi que ce soit avant elle. Sans
	// ce pas, elle jugeait une branche vide de tout le reste, et ne
	// découvrait une incompatibilité qu'en la fusionnant elle-même, à la
	// main — voir `orchestrator::sync_verifier_worktree`.
	let mut cohabitation = String::new();
	if role.verifies {
		match orchestrator::sync_verifier_worktree(&mission, &task, &cwd).await {
			Ok(rapport) if !rapport.conflicts.is_empty() => {
				cohabitation = format!(
					"\n\n── Coexistence with the other batches ──\n\
					 {} merged cleanly. In conflict, not merged — report it, it is a fact to \
					 deal with, not an assumption for you to check yourself: {}.",
					rapport.merged.len(),
					rapport.conflicts.join(", "),
				);
			}
			Ok(_) => {}
			Err(error) => {
				journal::record(
					"mission",
					&i18n::t("lib.mission.coexistenceUnchecked"),
					&task.title,
					false,
					&error.to_string(),
				);
			}
		}
	}

	let scope = if task.scope.is_empty() {
		"No scope declared: still stay within your responsibility.".to_string()
	} else {
		format!(
			"You only modify these paths: {}. File edits elsewhere are refused, and a branch \
			 that changes anything else is not merged, however the change was made.",
			task.scope.join(", ")
		)
	};

	let prompt = format!(
		"{role_prompt}

		 ── Mission: {mission_title}{ticket}
		 ── Your task: {task_title}
		 ── Integration branch: {branch}
		 {scope}

		 {brief}

		 The shared contracts — types, routes, schemas — are set on the integration branch: follow them, and report what you are missing rather than inventing it.

		 {directive}",
		directive = i18n::reply_directive(),
		role_prompt = prompt_with_verdict(&role),
		mission_title = mission.title,
		ticket = if mission.ticket.is_empty() {
			String::new()
		} else {
			format!(" ({})", mission.ticket)
		},
		task_title = task.title,
		branch = if mission.branch.is_empty() {
			"not set".into()
		} else {
			mission.branch.clone()
		},
		scope = scope,
		brief = task.brief,
	);
	let prompt = format!("{prompt}{cohabitation}");

	// Une vérification produit des preuves — captures, relevés d'API, rapports —
	// et git les ignore : elles n'ont rien à faire dans la branche qui partira en
	// production. Elles servent à l'ouverture de la pull request, et le cockpit
	// les rassemble lui-même dans le worktree d'intégration. Encore faut-il
	// qu'elles soient déposées là où il sait les trouver.
	let prompt = if role.verifies {
		format!(
			"{prompt}\n\n\
			 Put your evidence — screenshots, outputs, readings — under `.claude/work/qa/` \
			 in your worktree. It stays out of the branch, git ignores it: Cockpit \
			 gathers it when opening the pull request. Other people's code, however, \
			 is not to be touched."
		)
	} else {
		prompt
	};

	// Une vérification qui repasse sait où elle s'était arrêtée : relire vingt
	// fichiers pour valider une correction d'une ligne est ce qui faisait durer
	// les missions des heures. Elle reste libre d'élargir si le correctif touche
	// à ce qu'elle avait déjà validé.
	let prompt = if task.checkpoint.trim().is_empty() {
		prompt
	} else {
		format!(
			"{prompt}\n\n── You have already checked this work ──\n\
			 On your last pass, the branches were here: {}\n\
			 Focus on what has changed since — `git diff <sha>..<branch>` gives it to \
			 you. No need to redo everything: your previous verdict holds for the rest, \
			 unless the fix calls it into question.",
			task.checkpoint
		)
	};

	// La commande du rôle porte la méthode de l'équipe — lire un ticket, suivre
	// des conventions. Elle passe en tête : le reste du message lui sert de
	// contexte.
	let command = fill_command(&role.command, &mission, Some(&task));
	let prompt = if command.is_empty() {
		prompt
	} else {
		format!("{command}\n\n{prompt}")
	};

	// Un exécutant travaille seul, longtemps, sans personne pour compléter sa
	// consigne : c'est celui à qui il manque le plus de savoir ce que le cockpit
	// sait déjà — les leçons du carnet surtout, qui disent ce qu'on a eu à
	// reprendre dans ce dépôt.
	//
	// Au premier passage seulement : une tâche renvoyée en correction reprend sa
	// conversation, où le contexte est déjà chargé. Le lui renvoyer reviendrait à
	// le payer une fois de plus à chaque aller-retour.
	let prompt = if task.engine_session.trim().is_empty() {
		brief::for_agent(&cwd, &prompt).await
	} else {
		prompt
	};

	let session = agent::start_with_mission(
		app,
		agents,
		cwd,
		prompt,
		Some(role.permission_mode.clone()).filter(|mode| !mode.trim().is_empty()),
		Some(role.model.clone()).filter(|model| !model.is_empty()),
		// Reprendre plutôt que refaire : une tâche renvoyée en correction repart
		// sur la conversation qu'elle avait, avec son contexte déjà chargé. Vide
		// au premier passage — il n'y a rien à reprendre.
		Some(task.engine_session.clone()).filter(|session| !session.trim().is_empty()),
		Some(mission.id.clone()),
		// Le moteur du rôle : une recette peut être jugée par un autre modèle que
		// celui qui a écrit le code.
		Some(role.engine.clone()).filter(|engine| !engine.trim().is_empty()),
		role.depth.clone(),
		// Le périmètre voyage jusqu'au pont d'autorisation, qui refuse les
		// écritures du dehors quel que soit le mode. Sans lui, la barrière
		// annoncée à l'exécutant — « toute écriture ailleurs sera refusée » —
		// n'existait pas : un exécutant en `bypassPermissions` ne dépose aucune
		// demande, et il n'y avait donc rien à relire pour la faire respecter.
		task.scope.clone(),
		executions::Origin {
			actor: actor.to_string(),
			..executions::Origin::master(&task.role, &task.id, task.attempts)
		},
	)
	.await?;

	mission::attach_task(&id, &task_id, &session)?;
	journal::record(
		"mission",
		&i18n::t("lib.mission.workerLaunched"),
		&task.title,
		true,
		&format!("{} · {}", mission.title, task.role),
	);
	Ok(session)
}

/// Ouvre une mission depuis un ticket et lance son maître, d'un seul geste.
///
/// Le chemin ordinaire demandait de copier l'adresse du ticket, d'aller dans
/// Missions, de la coller, puis de lancer le maître : trois gestes pour une
/// intention unique, et autant d'occasions de se tromper de ticket. Ici on part
/// de ce qu'on regarde.
///
/// Une mission déjà ouverte sur ce ticket est rendue telle quelle plutôt que
/// doublée. Deux missions sur un même ticket viseraient la même branche
/// d'intégration et les mêmes worktrees : la seconde échouerait, ou pire,
/// reprendrait le travail de la première à son compte.
#[tauri::command]
pub(crate) async fn mission_start_from_ticket(app: AppHandle, reference: String) -> Result<Value> {
	let identifier = mission::ticket_reference(&reference);
	if identifier.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.mission.ticketNoId")));
	}

	let ouverte = mission::list().into_iter().find(|mission| {
		mission.ticket.eq_ignore_ascii_case(&identifier)
			&& !matches!(
				mission.state,
				mission::MissionState::Done | mission::MissionState::Failed
			)
	});
	if let Some(mission) = ouverte {
		return Ok(serde_json::json!({
			"mission": mission,
			"started": false,
			"message": i18n::tf("lib.mission.alreadyOpen", &[("identifier", &identifier)]),
		}));
	}

	let (mission, ticket) = create_mission_from_ticket(&reference).await?;
	let guided = mission.guided;
	// Le maître lancé dans la foulée : une mission ouverte et laissée sans maître
	// n'a rien fait avancer, et il faudrait revenir la démarrer à la main.
	let brief = ticket_brief(&ticket);
	let session = launch_master(app, mission.id.clone(), Some(brief), executions::Origin::human()).await?;
	let message = if guided {
		i18n::tf("lib.mission.openedGuided", &[("identifier", &identifier)])
	} else {
		i18n::tf("lib.mission.opened", &[("identifier", &identifier)])
	};
	Ok(serde_json::json!({
		"mission": mission::get(&mission.id).unwrap_or(mission),
		"started": true,
		"session": session,
		"message": message,
	}))
}

/// Lance l'agent maître d'une mission, avec ses outils d'orchestration.
///
/// Le prompt lui dit ce qu'on attend de lui — un plan, puis une intégration —
/// et surtout ce qu'il ne décide pas : l'accord humain sur le découpage.
#[tauri::command]
pub(crate) async fn mission_master_launch(app: AppHandle, id: String, brief: Option<String>) -> Result<String> {
	// Le geste vient de l'interface : c'est donc bien un humain qui demande.
	// Les boucles de fond, elles, passent par `launch_master` avec leur propre
	// acteur — sans quoi une mission relancée à trois heures du matin se
	// signerait de la main de quelqu'un qui dormait.
	launch_master(app, id, brief, executions::Origin::human()).await
}

pub(crate) async fn launch_master(
	app: AppHandle,
	id: String,
	brief: Option<String>,
	origin: executions::Origin,
) -> Result<String> {
	use tauri::Manager;
	let mission = mission::get(&id)?;

	crate::roles::check(&mission.cwd).map_err(|error| {
		CockpitError::msg(i18n::tf(
			"lib.mission.invalidRepoRoles",
			&[("file", &crate::roles::FILE), ("error", &error)],
		))
	})?;

	// Un maître lancé sans brief explicite (le bouton « Lancer le maître »
	// d'une mission déjà ouverte, par opposition au geste qui ouvre et lance
	// d'un coup) partait sans rien du ticket qui l'a pourtant fait naître —
	// vérifié en direct : « no existing context to work from ». Les deux
	// appels qui reprennent une mission en route passent toujours un brief
	// explicite ; celui-ci ne comble que le trou, jamais ne les court-circuite.
	let brief = match brief.filter(|b| !b.trim().is_empty()) {
		Some(brief) => Some(brief),
		None => fetch_ticket_brief(&mission).await,
	};

	// Sans Node, pas de pont MCP, donc pas d'outils de mission : le maître
	// démarrerait, discuterait, et ne pourrait ni soumettre son plan ni lancer un
	// exécutant. Mieux vaut ne pas le lancer et dire ce qui manque — c'est
	// exactement l'échec qu'on voyait passer pour un problème d'agent.
	if agent::node_binary().is_none() {
		return Err(CockpitError::msg(i18n::t(if cfg!(windows) {
			"windowsAgents.nodeMissing"
		} else {
			"lib.mission.nodeMissing"
		})));
	}

	let agents = app
		.try_state::<agent::SharedAgents>()
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.agentsUnavailable")))?
		.inner()
		.clone();

	// Les rôles qui jugent sont annoncés comme tels : le maître planifiait des
	// recettes en parallèle de l'implémentation, faute de savoir que le cockpit
	// les retiendrait de toute façon.
	let roles = roles_for(&mission.cwd)
		.into_iter()
		// Le maître ne se confie pas de tâche à lui-même : sa clé n'a rien à
		// faire dans la liste qu'il utilise pour découper.
		.filter(|role| role.id != config::MASTER_ROLE)
		.map(|role| {
			if role.verifies {
				format!(
					"- `{}`: {} — judges the others' work, only starts once the \
					 implementation is delivered",
					role.id, role.label
				)
			} else {
				format!("- `{}`: {}", role.id, role.label)
			}
		})
		.collect::<Vec<_>>()
		.join("\n");

	let prompt = format!(
		// Ce prompt dit ce que le maître opère et ce qu'il ne décide pas. Il
		// n'énumère plus les étapes : les outils les portent déjà, et les répéter
		// revenait à piloter à sa place quelqu'un dont on attend du jugement.
		// Ne restent que les contraintes qu'il ne peut pas deviner — l'accord
		// humain, et le fait que les périmètres sont réellement appliqués.
		"You are the master agent of the mission \"{title}\"{ticket}.\n\n\
		 You break the work down, hand it to workers, and recombine what they \
		 deliver on the integration branch `{branch}`. The mission tools are yours; \
		 each one says what it does.\n\n\
		 Two things you do not decide. Your plan waits for the user's agreement: \
		 nothing starts before that, whatever you think of it. And the path scopes \
		 you declare are enforced — a file edit outside them is refused and a branch \
		 that changes anything else is not merged; it is not an instruction but a \
		 barrier.\n\n\
		 Available roles:\n{roles}\n\n\
		 A worker only sees its own instructions: what you do not write to it, it \
		 does not have. Two workers writing in the same place will get in each \
		 other's way whatever you tell them.\n\n\
		 {directive}\n\n{guided}{lessons}{conventions}{brief}",
		directive = i18n::reply_directive(),
		conventions = brief::conventions_for(&mission.cwd),
		guided = if mission.guided {
			format!("{}\n\n", guided_brief(&mission))
		} else {
			String::new()
		},
		title = mission.title,
		ticket = if mission.ticket.is_empty() {
			String::new()
		} else {
			format!(" (issue {})", mission.ticket)
		},
		branch = mission.branch,
		roles = roles,
		// Ce que les missions précédentes ont appris. Le maître repartait de zéro
		// à chaque fois et refaisait les mêmes découpages ratés — une recette sans
		// exécutant rattaché, deux rôles sur le même dossier — alors que le motif
		// de l'échec était écrit dans la mission d'avant.
		lessons = {
			let passe = mission::lessons(5);
			if passe.is_empty() {
				String::new()
			} else {
				format!("{passe}\n\n")
			}
		},
		brief = brief.unwrap_or_default(),
	);

	// Le maître travaille sur la branche d'intégration, dans son propre
	// worktree. Deux raisons : c'est là que vivent les contrats que suivront les
	// exécutants, et c'est ce qui rend son mode permissif acceptable — un dossier
	// dédié à la mission, jamais le dépôt principal.
	let cwd = match orchestrator::integration_worktree(&mission).await {
		Ok(path) => path,
		// Surtout pas de repli sur le dépôt principal. C'est là que vit la
		// branche de travail de l'utilisateur : un maître lâché dedans y écrit
		// ses contrats, y commite, et transforme un dépôt propre en chantier.
		// Mieux vaut refuser de démarrer et dire pourquoi.
		Err(error) => {
			return Err(CockpitError::msg(i18n::tf(
				"lib.mission.integrationWorktreeFailed",
				&[("branch", &mission.branch), ("error", &error)],
			)))
		}
	};

	// Le rôle `master` du catalogue règle ce qui lui est propre : sa commande de
	// démarrage, sa consigne permanente, son modèle. Le reste — les outils
	// d'orchestration, les étapes — vient du cockpit et ne se configure pas.
	let master = role_config(&mission.cwd, config::MASTER_ROLE);
	let command = master
		.as_ref()
		.map(|role| fill_command(&role.command, &mission, None))
		.filter(|command| !command.is_empty());
	let consigne = master
		.as_ref()
		.map(|role| role.prompt.trim())
		.filter(|prompt| !prompt.is_empty())
		.unwrap_or_default();

	// La commande d'abord : c'est elle qui porte la méthode de l'équipe, et le
	// CLI la résout où qu'elle soit dans le message.
	let prompt = match (&command, consigne.is_empty()) {
		(Some(command), false) => format!("{command}\n\n{consigne}\n\n{prompt}"),
		(Some(command), true) => format!("{command}\n\n{prompt}"),
		(None, false) => format!("{consigne}\n\n{prompt}"),
		(None, true) => prompt,
	};

	let session = agent::start_with_mission(
		app,
		agents,
		cwd,
		prompt,
		// Le maître enchaîne lecture, écriture de contrats et appels d'outils :
		// lui demander une autorisation à chaque geste revient à le piloter à la
		// main, ce qui est exactement ce qu'on cherche à éviter. Son terrain est
		// isolé, et ses exécutants, eux, gardent leurs garde-fous.
		Some(
			master
				.as_ref()
				.map(|role| role.permission_mode.clone())
				.filter(|mode| !mode.is_empty())
				.unwrap_or_else(|| "bypassPermissions".into()),
		),
		master
			.as_ref()
			.map(|role| role.model.clone())
			.filter(|model| !model.is_empty()),
		None,
		Some(mission.id.clone()),
		master
			.as_ref()
			.map(|role| role.engine.clone())
			.filter(|engine| !engine.trim().is_empty()),
		master.as_ref().map(|role| role.depth.clone()).unwrap_or_default(),
		// Le maître écrit les contrats de la mission dans son propre worktree :
		// le borner reviendrait à l'empêcher de faire son travail.
		Vec::new(),
		executions::Origin {
			role: config::MASTER_ROLE.to_string(),
			..origin
		},
	)
	.await?;

	mission::attach_master(&id, &session)?;
	journal::record(
		"mission",
		&i18n::t("lib.mission.masterLaunched"),
		&mission.title,
		true,
		"",
	);
	Ok(session)
}

/// Ce que le maître d'une mission guidée doit savoir de son parcours, et
/// d'où il repart.
///
/// Relu à chaque lancement plutôt que figé à l'ouverture : un maître relancé
/// après un redémarrage du cockpit n'a plus sa conversation, et doit
/// retrouver ici ce qui a déjà été validé — sans quoi il relirait le ticket
/// et reproposerait une compréhension que l'utilisateur a déjà signée.
pub(crate) fn guided_brief(mission: &mission::Mission) -> String {
	use mission::MissionState as S;
	let mut text = String::from(
		"This mission is guided: the user reads the issue at the same time as you, and three \
		 agreements mark out your work. You only move on to the next step after theirs — the \
		 tools refuse otherwise.\n\n\
		 1. Understanding (`understand`). Read the issue, its comments, then the code it \
		 touches, without modifying anything. Return what you understood in 10 lines at most, \
		 for a developer discovering the issue: what is asked, why, what is out of scope. \
		 Simple words, one idea per line, no plan. What you could not settle goes into \
		 `questions`, never into the text: an ambiguity buried in a summary reads like a \
		 certainty.\n\
		 2. Approach (`approach`). How you intend to go about it: the steps, the places in the \
		 code, the order, the risks. 15 lines at most, readable by a human, without splitting \
		 between workers yet.\n\
		 3. Breakdown (`plan`). The tasks handed to the workers, faithful to the approved \
		 approach.\n\n\
		 After each submission, stop. The user's answer reaches you by message: an approval, \
		 or a correction you take into account before submitting a new version.",
	);

	let validated = |drafts: &[mission::Draft]| -> Option<String> {
		let last = drafts.last()?;
		let review = last.review.as_ref().filter(|review| review.approved)?;
		let mut block = last.text.clone();
		let answers = answered(&last.questions, &review.answers);
		if !answers.is_empty() {
			block.push_str(&format!("\n{answers}"));
		}
		if !review.feedback.is_empty() {
			block.push_str(&format!("\nUser's clarification: {}", review.feedback));
		}
		Some(block)
	};
	if let Some(block) = validated(&mission.understanding) {
		text.push_str(&format!("\n\n── Understanding approved ──\n{block}"));
	}
	if let Some(block) = validated(&mission.approach) {
		text.push_str(&format!("\n\n── Approach approved ──\n{block}"));
	}

	let now = match mission.state {
		S::Understanding => "start with the understanding.",
		S::Approaching => "your understanding is approved: the approach is yours.",
		S::Planning => "your approach is approved: the breakdown is yours.",
		S::AwaitingUnderstanding | S::AwaitingApproach | S::AwaitingApproval => {
			"your last proposal is waiting for the user's answer: call nothing, wait for \
			 their message."
		}
		_ => "the breakdown is approved; the workers are working.",
	};
	text.push_str(&format!("\n\nWhere the mission stands: {now}"));
	text
}

/// Les réponses de l'utilisateur, face aux questions qu'elles tranchent.
pub(crate) fn answered(questions: &[String], answers: &[String]) -> String {
	questions
		.iter()
		.zip(answers.iter())
		.filter(|(_, answer)| !answer.trim().is_empty())
		.map(|(question, answer)| format!("- {question} → {}", answer.trim()))
		.collect::<Vec<_>>()
		.join("\n")
}

/// Le message qui porte une décision humaine jusqu'au maître.
///
/// Pur : c'est le seul endroit où une validation devient une consigne, et
/// une consigne mal dite ici fait sauter une étape au maître.
pub(crate) fn review_message(mission: &mission::Mission, step: mission::Step, approved: bool) -> String {
	let drafts = match step {
		mission::Step::Understanding => &mission.understanding,
		mission::Step::Approach => &mission.approach,
		mission::Step::Split => &mission.split,
	};
	let review = drafts.last().and_then(|draft| draft.review.clone());
	let questions = drafts.last().map(|draft| draft.questions.clone()).unwrap_or_default();
	let mut details = String::new();
	if let Some(review) = &review {
		let answers = answered(&questions, &review.answers);
		if !answers.is_empty() {
			details.push_str(&format!("\n\nTheir answers to your questions:\n{answers}"));
		}
		if !review.feedback.is_empty() {
			details.push_str(&format!(
				"\n\n{}:\n{}",
				if approved { "What they add" } else { "What they correct" },
				review.feedback
			));
		}
	}

	let next = match (step, approved) {
		(mission::Step::Understanding, true) => {
			"Move on to the approach: how you intend to go about it, then `approach`. Do not break \
			 it down yet."
		}
		(mission::Step::Understanding, false) => {
			"Rework your understanding taking the above into account, then submit a new \
			 version with `understand`."
		}
		(mission::Step::Approach, true) => {
			"Move on to the breakdown: the workers' tasks, faithful to this approach, then `plan`."
		}
		(mission::Step::Approach, false) => {
			"Rework your approach taking the above into account, then submit a new version \
			 with `approach`."
		}
		(mission::Step::Split, _) => {
			"Rework your breakdown taking the above into account, then submit it again with \
			 `plan`."
		}
	};
	format!(
		"The user {} your {}.{details}\n\n{next}",
		if approved { "approves" } else { "corrects" },
		step.protocol_label()
	)
}

/// Valide ou corrige une étape d'une mission guidée, et le fait savoir au
/// maître.
///
/// Le découpage validé fait partir les exécutants, comme l'approbation d'un
/// plan autonome. Toute autre décision redescend au maître : dans sa
/// conversation s'il est encore là — il garde tout ce qu'il a lu —, sinon
/// par un maître neuf qui repart de ce qui a été validé.
#[tauri::command]
pub(crate) async fn mission_review(
	app: AppHandle,
	id: String,
	step: mission::Step,
	approved: bool,
	feedback: Option<String>,
	answers: Option<Vec<String>>,
) -> Result<mission::Mission> {
	let mission = mission::review(
		&id,
		step,
		approved,
		&feedback.unwrap_or_default(),
		answers.unwrap_or_default(),
	)?;

	if step == mission::Step::Split && approved {
		launch_ready_tasks(app, &id).await;
		return mission::get(&id);
	}

	let message = review_message(&mission, step, approved);
	guide_master(&app, &mission, &message).await?;
	mission::get(&id)
}

/// Transmet une consigne au maître d'une mission — dans sa conversation s'il
/// vit encore, sinon en en lançant un neuf.
pub(crate) async fn guide_master(app: &AppHandle, mission: &mission::Mission, message: &str) -> Result<()> {
	use tauri::Manager;
	if let (Some(session), Some(agents)) = (
		mission.master_session.as_deref(),
		app.try_state::<agent::SharedAgents>(),
	) {
		// Sa conversation d'abord : il y a lu le ticket et le code, et un maître
		// neuf paierait cette lecture une seconde fois.
		if agent::send(app, agents.inner(), session, message).await.is_ok() {
			return Ok(());
		}
		// Plus personne au bout : on range ce qui reste avant d'en lancer un
		// autre, sans quoi deux maîtres finiraient par tenir la même mission.
		let _ = agent::stop(agents.inner(), session);
	}
	let ticket = fetch_ticket_brief(mission).await.unwrap_or_default();
	let brief = if ticket.is_empty() {
		message.to_string()
	} else {
		format!("{ticket}\n\n{message}")
	};
	launch_master(
		app.clone(),
		mission.id.clone(),
		Some(brief),
		executions::Origin::human(),
	)
	.await
	.map(|_| ())
}

/// Le ticket d'une mission, relu chez le fournisseur et mis en forme.
pub(crate) async fn fetch_ticket_brief(mission: &mission::Mission) -> Option<String> {
	if mission.ticket.trim().is_empty() {
		return None;
	}
	let config = cfg();
	let provider = tickets::provider(&config).ok()?;
	let ticket = provider.get(&mission.ticket).await.ok()?;
	Some(ticket_brief(&ticket))
}

/// Ouvre la pull request d'une mission depuis son worktree d'intégration.
///
/// Passe par le même chemin que l'interface — pousser, puis demander à la forge
/// — pour qu'une PR ouverte par le maître soit indiscernable d'une PR ouverte à
/// la main.
/// Le rôle du catalogue d'un projet, ou celui par défaut quand il n'y est pas.
///
/// Le catalogue se lit depuis le dépôt de la mission, jamais depuis l'écran
/// affiché : c'est là que vivent les commandes d'équipe — `/self-qa`,
/// `/code-review-process` — et une mission qui les perd tourne avec les rôles
/// génériques sans que rien ne le dise.
pub(crate) fn role_config(repo: &str, id: &str) -> Option<config::RoleConfig> {
	let configured = roles_for(repo).into_iter().find(|role| role.id == id);
	configured.or_else(|| config::default_roles().into_iter().find(|role| role.id == id))
}

/// Remplace dans une commande ce qui vient de la mission et de la tâche.
///
/// Les commandes d'équipe attendent un argument — l'adresse du ticket, le plus
/// souvent. L'écrire à la main dans la configuration reviendrait à figer une
/// mission ; on substitue donc au lancement.
pub(crate) fn fill_command(template: &str, mission: &mission::Mission, task: Option<&mission::Task>) -> String {
	let mut filled = template.trim().to_string();
	for (motif, valeur) in [
		("{ticket}", mission.ticket.as_str()),
		("{ticketUrl}", mission.ticket_url.as_str()),
		("{branch}", mission.branch.as_str()),
		("{mission}", mission.title.as_str()),
		("{task}", task.map(|t| t.title.as_str()).unwrap_or_default()),
		("{brief}", task.map(|t| t.brief.as_str()).unwrap_or_default()),
	] {
		filled = filled.replace(motif, valeur);
	}
	filled
}

/// La commande d'équipe qui ouvre une pull request sur ce projet, s'il en a une.
///
/// Lue depuis le dépôt de la mission : `/pull-request-creation` existe chez l'un
/// et pas chez l'autre, et faire jouer au maître une commande introuvable lui
/// ferait perdre son tour.
pub fn mission_pr_command(mission: &mission::Mission) -> Option<String> {
	let template = config::Config::for_repo(&mission.cwd).workflow.pr_command;
	let filled = fill_command(&template, mission, None);
	(!filled.trim().is_empty()).then_some(filled)
}

/// Sur quoi la pull request d'une mission se greffe.
///
/// Ce que la mission déclare, sinon la branche par défaut du dépôt. Résolu au
/// moment d'ouvrir plutôt qu'à la création : une mission ouverte il y a trois
/// semaines ne doit pas viser une base qui a changé de nom entre-temps.
pub async fn mission_base(mission: &mission::Mission) -> String {
	if !mission.base.trim().is_empty() {
		return mission.base.trim().to_string();
	}
	match main_repo() {
		Ok(repo) => git::default_branch(&repo).await,
		Err(_) => "main".to_string(),
	}
}

pub async fn open_mission_pr(cwd: &str, branch: &str, base: &str, title: &str, body: &str) -> Result<String> {
	// La branche est nommée, jamais déduite de `HEAD` : le dossier d'où l'on
	// pousse n'a aucune raison d'être posé sur celle de la mission, et la PR
	// partait donc de ce qui traînait là.
	create_pr_on(cwd, branch, base, title, Some(body.to_string()), false).await
}

/// Le dossier de livraison d'une mission, tel que l'écran le montre et que la
/// pull request le recevrait.
#[tauri::command]
pub(crate) async fn mission_dossier(id: String) -> Result<delivery::Dossier> {
	delivery::compose(&id).await
}

/// Publie (ou republie) le dossier sur la pull request de la mission.
#[tauri::command]
pub(crate) async fn mission_dossier_publish(id: String) -> Result<String> {
	delivery::publish(&id).await
}

/// Ce qu'il manque au poste pour lancer des agents : la liste « prêt à
/// démarrer » de la carte.
#[tauri::command]
pub(crate) async fn readiness_check() -> readiness::Readiness {
	readiness::observe().await
}

/// Ce que les exécutants de cette mission pourront faire sans rien demander :
/// ce que l'écran dit au moment d'approuver le plan.
///
/// Les rôles viennent du projet de la mission (`roles_for`), l'isolation du
/// réglage que le lanceur lit lui-même (`agent::start_with_mission`) : la
/// mise en garde dit ce qui se passera, pas ce qu'un autre écran suppose.
#[tauri::command]
pub(crate) fn mission_exposure(id: String) -> Result<mission::Exposure> {
	let mission = mission::get(&id)?;
	Ok(mission::exposure(
		&mission.tasks,
		&roles_for(&mission.cwd),
		config::Config::active().sandbox.enabled,
	))
}

#[tauri::command]
pub(crate) async fn mission_pr(id: String, title: Option<String>, body: Option<String>) -> Result<mission::Mission> {
	let mission = mission::get(&id)?;

	// Ouvrir la pull request clôt la mission et range ses worktrees : ce qui
	// n'est pas dans la branche d'intégration à cet instant se retrouve sur une
	// branche que plus rien ne nomme. On refuse plutôt que de perdre le travail
	// en silence — une tâche dont on ne veut plus se marque échouée, et là c'est
	// une décision, pas un oubli.
	// Une vérification qui refuse est un refus, pas un avis. Elle avait nommé le
	// défaut, elle l'avait écrit, et la pull request s'ouvrait quand même :
	// personne d'autre que le maître ne lisait ce verdict, et un maître peut
	// passer à côté. Se lever demande de corriger puis de la relancer — elle
	// rejugera, et c'est ce nouveau jugement qui ouvrira la porte.
	let verifiers: Vec<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();
	// Une vérification qui n'a pas conclu ne vaut pas accord. Ouvrir la pull
	// request sur son silence reviendrait à lire « je ne sais pas » comme « rien
	// à redire » — la confusion que l'oracle de la Permanence a nommée comme son
	// pire mode de défaillance. Le refus se lève sans rien perdre : la
	// vérification reformule, ou la tâche s'assume abandonnée.
	let indecises = mission::unclear_verdicts(&mission, &verifiers);
	if !indecises.is_empty() {
		let liste = indecises
			.iter()
			.map(|task| i18n::tf("lib.quoted", &[("text", &task.title)]))
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf(
			"lib.mission.unclearVerdict",
			&[("tasks", &liste)],
		)));
	}

	let refus = mission::blocking_verdicts(&mission, &verifiers);
	if !refus.is_empty() {
		let liste = refus
			.iter()
			.map(|task| i18n::tf("lib.quoted", &[("text", &task.title)]))
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf(
			"lib.mission.blockingVerdict",
			&[("tasks", &liste)],
		)));
	}

	let dehors = mission::unintegrated(&mission);
	if !dehors.is_empty() {
		let liste = dehors
			.iter()
			.map(|task| {
				format!(
					"{} ({:?})",
					i18n::tf("lib.quoted", &[("text", &task.title)]),
					task.state
				)
			})
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf(
			"lib.mission.unintegrated",
			&[("count", &dehors.len()), ("branch", &mission.branch), ("tasks", &liste)],
		)));
	}

	let url = open_mission_pr(
		&mission.cwd,
		&mission.branch,
		&mission_base(&mission).await,
		&title.unwrap_or_else(|| mission.title.clone()),
		&body.unwrap_or_default(),
	)
	.await?;
	let closed = mission::finish(&id, &url)?;
	delivery::publish_on_close(&id);
	let _ = mission::cleanup(&id).await;
	Ok(closed)
}

/// Range les worktrees des tâches intégrées, à la demande.
#[tauri::command]
pub(crate) async fn mission_cleanup(id: String) -> Result<Vec<String>> {
	mission::cleanup(&id).await
}

#[tauri::command(async)]
pub(crate) fn roles_list() -> Vec<config::RoleConfig> {
	roles_for(&cfg().general.main_repo)
}

/// Le catalogue de rôles d'un dépôt, jamais vide.
///
/// Ce que le lanceur consulte pour savoir qui juge le travail des autres : lu
/// depuis le projet de la mission, il ne dépend plus de l'écran ouvert.
pub(crate) fn roles_for(repo: &str) -> Vec<config::RoleConfig> {
	let roles = config::Config::for_repo(repo).roles;
	let local = if roles.is_empty() {
		config::default_roles()
	} else {
		roles
	};
	crate::roles::with_repo(repo, local)
}

#[cfg(test)]
mod prompt_with_verdict_tests {
	use super::*;

	fn role(prompt: &str, verifies: bool) -> config::RoleConfig {
		config::RoleConfig {
			prompt: prompt.into(),
			verifies,
			..Default::default()
		}
	}

	#[test]
	fn un_role_qui_verifie_recoit_la_forme_du_verdict() {
		let consigne = prompt_with_verdict(&role("Relis la branche.", true));
		assert!(consigne.starts_with("Relis la branche."));
		for verdict in ["VERDICT: blocking", "VERDICT: concerns", "VERDICT: ok"] {
			assert!(mission::read_verdict(verdict).is_some());
			assert!(consigne.contains(verdict), "{consigne}");
		}
	}

	#[test]
	fn les_autres_consignes_ne_changent_pas() {
		assert_eq!(prompt_with_verdict(&role("Écris le code.", false)), "Écris le code.");
		let deja = "Conclus par `VERDICT: ok`.";
		assert_eq!(prompt_with_verdict(&role(deja, true)), deja);
	}

	#[test]
	fn les_roles_par_defaut_n_ont_pas_de_verdict_en_double() {
		for role in config::default_roles().iter().filter(|role| role.verifies) {
			assert_eq!(prompt_with_verdict(role), role.prompt, "{}", role.id);
		}
	}
}
