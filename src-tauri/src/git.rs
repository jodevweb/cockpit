//! Lecture de l'état git : worktrees, propreté de l'arbre, position vs upstream.
//!
//! Tout passe par le binaire `git` plutôt que par une lib : c'est le même
//! comportement que ce que tu vois en terminal (hooks, config, includes), et
//! ça évite d'embarquer libgit2.

use crate::error::{CockpitError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
	pub sha: String,
	pub subject: String,
	pub author: String,
	pub relative: String,
	pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
	pub modified: usize,
	pub staged: usize,
	pub untracked: usize,
	pub conflicted: usize,
	pub ahead: usize,
	pub behind: usize,
	pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
	pub path: String,
	pub folder_name: String,
	pub branch: Option<String>,
	pub head: String,
	pub is_main: bool,
	pub is_detached: bool,
	pub is_locked: bool,
	pub status: WorktreeStatus,
	pub last_commit: Option<Commit>,
	/// Dernière écriture connue dans l'arbre (mtime du `.git` du worktree).
	pub last_activity: Option<i64>,
}

pub async fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
	let output = crate::platform::quiet_async(&mut Command::new("git"))
		.args(args)
		.current_dir(cwd)
		.output()
		.await
		.map_err(|e| CockpitError::msg(format!("git {} : {e}", args.join(" "))))?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		return Err(CockpitError::msg(crate::i18n::tf(
			"git.commandFailed",
			&[("args", &args.join(" ")), ("error", &stderr)],
		)));
	}
	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Branche sortie dans ce dossier.
pub async fn current_branch(path: &Path) -> Result<String> {
	let name = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
		.await?
		.trim()
		.to_string();
	if name == "HEAD" {
		return Err(CockpitError::msg(crate::i18n::t("git.detachedHead")));
	}
	Ok(name)
}

/// Met de côté le travail en cours, fichiers non suivis compris.
///
/// `-u` : sans lui, les fichiers neufs restent sur place et l'arbre n'est pas
/// vraiment propre — ce qu'on croyait avoir rangé réapparaît au checkout.
pub async fn stash_push(path: &Path, message: &str) -> Result<String> {
	let message = message.trim();
	let mut args = vec!["stash", "push", "-u"];
	if !message.is_empty() {
		args.push("-m");
		args.push(message);
	}
	run_git(path, &args).await
}

/// Remet le dernier remisage et le retire de la pile.
pub async fn stash_pop(path: &Path) -> Result<String> {
	run_git(path, &["stash", "pop"]).await
}

/// Remisages du dossier, du plus récent au plus ancien.
pub async fn stash_list(path: &Path) -> Result<Vec<String>> {
	let raw = run_git(path, &["stash", "list", "--pretty=%gd — %s"]).await?;
	Ok(raw
		.lines()
		.filter(|line| !line.trim().is_empty())
		.map(|line| line.to_string())
		.collect())
}

/// Récupère l'état du dépôt distant sans rien changer localement.
pub async fn fetch(path: &Path) -> Result<String> {
	run_git(path, &["fetch", "--prune"]).await
}

/// Met la branche à jour, sans jamais fabriquer de commit de merge.
///
/// `--ff-only` plutôt que le comportement par défaut : une divergence doit se
/// régler en connaissance de cause, pas produire un merge surprise ni un
/// conflit à résoudre dans une interface qui n'a pas d'éditeur.
pub async fn pull(path: &Path) -> Result<String> {
	run_git(path, &["pull", "--ff-only"]).await
}

/// Publie la branche courante, en posant son amont au premier envoi.
pub async fn push(path: &Path) -> Result<String> {
	run_git(path, &["push", "--set-upstream", "origin", "HEAD"]).await
}

/// Publie une branche nommée, depuis n'importe quel dossier du dépôt.
///
/// Une mission ne peut pas compter sur `HEAD` : sa branche d'intégration est
/// extraite dans un worktree à elle, quand le maître, lui, travaille ailleurs.
/// Pousser « la branche courante » publiait donc ce qui se trouvait sous la
/// main plutôt que ce qu'on voulait livrer.
pub async fn push_branch(path: &Path, branch: &str) -> Result<String> {
	run_git(path, &["push", "--set-upstream", "origin", branch]).await
}

/// Enregistre tout le travail en cours en un commit.
///
/// `add -A` assume le geste courant du cockpit — on valide un état, pas une
/// sélection de fichiers ; la mise en scène fine reste l'affaire du terminal.
pub async fn commit_all(path: &Path, message: &str) -> Result<String> {
	let message = message.trim();
	if message.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("git.commitMessageRequired")));
	}
	run_git(path, &["add", "-A"]).await?;
	run_git(path, &["commit", "-m", message]).await
}

/// `git worktree list --porcelain` → chemins bruts, dans l'ordre déclaré par git
/// (le premier est toujours le worktree principal).
async fn list_raw(main_repo: &Path) -> Result<Vec<(PathBuf, String, Option<String>, bool, bool)>> {
	let raw = run_git(main_repo, &["worktree", "list", "--porcelain"]).await?;
	let mut out = Vec::new();
	let mut path: Option<PathBuf> = None;
	let mut head = String::new();
	let mut branch: Option<String> = None;
	let mut detached = false;
	let mut locked = false;

	let flush = |path: &mut Option<PathBuf>,
	             head: &mut String,
	             branch: &mut Option<String>,
	             detached: &mut bool,
	             locked: &mut bool,
	             out: &mut Vec<_>| {
		if let Some(p) = path.take() {
			out.push((p, std::mem::take(head), branch.take(), *detached, *locked));
			*detached = false;
			*locked = false;
		}
	};

	for line in raw.lines() {
		if let Some(rest) = line.strip_prefix("worktree ") {
			flush(&mut path, &mut head, &mut branch, &mut detached, &mut locked, &mut out);
			path = Some(PathBuf::from(rest));
		} else if let Some(rest) = line.strip_prefix("HEAD ") {
			head = rest.to_string();
		} else if let Some(rest) = line.strip_prefix("branch ") {
			branch = Some(rest.trim_start_matches("refs/heads/").to_string());
		} else if line == "detached" {
			detached = true;
		} else if line.starts_with("locked") {
			locked = true;
		}
	}
	flush(&mut path, &mut head, &mut branch, &mut detached, &mut locked, &mut out);

	Ok(out)
}

async fn read_status(path: &Path) -> WorktreeStatus {
	let mut status = WorktreeStatus {
		modified: 0,
		staged: 0,
		untracked: 0,
		conflicted: 0,
		ahead: 0,
		behind: 0,
		upstream: None,
	};

	let Ok(raw) = run_git(path, &["status", "--porcelain=v2", "--branch"]).await else {
		return status;
	};

	for line in raw.lines() {
		if let Some(rest) = line.strip_prefix("# branch.upstream ") {
			status.upstream = Some(rest.to_string());
		} else if let Some(rest) = line.strip_prefix("# branch.ab ") {
			// Format « +2 -3 ».
			for token in rest.split_whitespace() {
				let (sign, value) = token.split_at(1);
				let n = value.parse::<usize>().unwrap_or(0);
				match sign {
					"+" => status.ahead = n,
					"-" => status.behind = n,
					_ => {}
				}
			}
		} else if let Some(rest) = line.strip_prefix("1 ").or_else(|| line.strip_prefix("2 ")) {
			// XY <sub> … : X = index, Y = worktree.
			let xy = rest.split_whitespace().next().unwrap_or("..");
			let mut chars = xy.chars();
			let index = chars.next().unwrap_or('.');
			let worktree = chars.next().unwrap_or('.');
			if index != '.' {
				status.staged += 1;
			}
			if worktree != '.' {
				status.modified += 1;
			}
		} else if line.starts_with("? ") {
			status.untracked += 1;
		} else if line.starts_with("u ") {
			status.conflicted += 1;
		}
	}

	status
}

async fn read_last_commit(path: &Path) -> Option<Commit> {
	let raw = run_git(path, &["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%ar%x1f%at"])
		.await
		.ok()?;
	parse_commit_line(raw.trim())
}

fn parse_commit_line(line: &str) -> Option<Commit> {
	let mut parts = line.split('\u{1f}');
	Some(Commit {
		sha: parts.next()?.to_string(),
		subject: parts.next()?.to_string(),
		author: parts.next()?.to_string(),
		relative: parts.next()?.to_string(),
		timestamp: parts.next()?.parse().unwrap_or(0),
	})
}

fn mtime_of(path: &Path) -> Option<i64> {
	std::fs::metadata(path)
		.and_then(|m| m.modified())
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_secs() as i64)
}

/// Où cette branche est-elle extraite ?
///
/// Une branche ne vit que dans un seul dossier à la fois : git refuse de
/// l'extraire deux fois. Le savoir évite de supposer qu'elle est sous `HEAD`
/// là où l'on écrit — supposition qui fait atterrir un merge dans la branche
/// de travail de l'utilisateur.
pub async fn worktree_for_branch(main_repo: &Path, branch: &str) -> Result<Option<PathBuf>> {
	let branch = branch.trim();
	if branch.is_empty() {
		return Ok(None);
	}
	Ok(list_raw(main_repo)
		.await?
		.into_iter()
		.find(|(_, _, name, _, _)| name.as_deref() == Some(branch))
		.map(|(path, ..)| path))
}

/// Le worktree principal du dépôt : celui qui porte le vrai `.git`.
///
/// C'est la copie de travail de l'utilisateur. Le cockpit a besoin de savoir la
/// reconnaître pour ne jamais écrire dedans.
pub async fn main_worktree(repo: &Path) -> Result<PathBuf> {
	list_raw(repo)
		.await?
		.into_iter()
		.next()
		.map(|(path, ..)| path)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("git.noWorktree")))
}

/// Ce qu'un worktree occupe, et ce qu'on récupérerait sans rien perdre.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
	pub path: String,
	/// Poids total, tel que le système le rapporte.
	pub bytes: u64,
	/// Ce que pèsent les sorties de build et les caches.
	///
	/// **C'est le seul chiffre qui coûte vraiment.** Ces dossiers sont produits
	/// localement, uniques à chaque worktree, partagés avec rien : sur un poste
	/// où trente-cinq worktrees cohabitent, ce sont eux, et eux seuls, qui
	/// remplissent le disque. Les effacer ne perd jamais de travail — une
	/// commande les reconstruit.
	pub builds: u64,
	/// Ce que pèsent les dépendances installées.
	///
	/// Compté à part parce que **ce poids-là est une illusion**. Sur APFS, pnpm
	/// clone ses paquets depuis son store au lieu de les copier : les blocs sont
	/// partagés, `du` les compte pourtant en entier dans chaque worktree.
	/// Vérifié en clonant un dossier à la main — la taille rapportée augmente,
	/// l'espace libre du disque ne bouge pas. Les confondre avec les builds
	/// ferait supprimer des worktrees entiers pour ne rien récupérer.
	pub dependencies: u64,
	pub measured_at: i64,
}

/// Les sorties de build et les caches, qu'une commande sait reconstruire.
///
/// Une liste nommée plutôt qu'une heuristique de taille : effacer un dossier
/// parce qu'il est gros serait un pari, l'effacer parce qu'on sait quelle
/// commande le refait est une décision.
const BUILDS: &[&str] = &[
	".next",
	".turbo",
	".nuxt",
	".svelte-kit",
	".parcel-cache",
	"dist",
	"build",
	"coverage",
	"storybook-static",
];

/// Ce qu'un gestionnaire de paquets réinstalle.
const DEPENDENCIES: &[&str] = &["node_modules"];

/// Jusqu'où descendre pour les trouver.
///
/// Un monorepo range ses applications à `apps/<nom>/.next` : trois niveaux
/// suffisent, quatre laissent de la marge. Au-delà, on ne trouverait plus que
/// les `dist` des dépendances elles-mêmes — qu'il ne faut surtout pas toucher.
const SEARCH_DEPTH: usize = 4;

/// Combien de mesures à la fois. Mesurer parcourt des centaines de milliers
/// d'inodes ; les lancer toutes ensemble saturerait le disque pour un carnet.
const PARALLEL_MEASURES: usize = 4;

/// Combien de temps une mesure reste valable. Un worktree ne change pas de
/// taille toutes les minutes, et la mesure coûte cher.
const MEASURE_TTL_SECONDS: i64 = 600;

fn usage_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, DiskUsage>> {
	static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, DiskUsage>>> =
		std::sync::OnceLock::new();
	CACHE.get_or_init(Default::default)
}

/// Le poids d'un dossier, par `du`.
///
/// `du` plutôt qu'un parcours maison : c'est l'outil du système pour ça, il
/// compte les blocs occupés et ne suit pas les liens symboliques. Rend `None`
/// quand rien ne se lit — une taille inconnue ne doit pas passer pour un zéro.
///
/// Windows n'a pas de `du` : on additionne la taille des fichiers, sans suivre
/// les liens — l'octet près plutôt que le bloc, l'ordre de grandeur est le même.
#[cfg(windows)]
async fn du_bytes(path: &Path) -> Option<u64> {
	let root = path.to_path_buf();
	tokio::task::spawn_blocking(move || {
		if !root.is_dir() {
			return None;
		}
		Some(
			walkdir::WalkDir::new(&root)
				.follow_links(false)
				.into_iter()
				.filter_map(|entry| entry.ok())
				.filter(|entry| entry.file_type().is_file())
				.filter_map(|entry| entry.metadata().ok())
				.map(|meta| meta.len())
				.sum(),
		)
	})
	.await
	.ok()?
}

#[cfg(not(windows))]
async fn du_bytes(path: &Path) -> Option<u64> {
	let output = Command::new("du").arg("-sk").arg(path).output().await.ok()?;
	// `du` sort en erreur dès qu'un sous-dossier est illisible, tout en ayant
	// compté le reste : on lit sa sortie plutôt que son code.
	let texte = String::from_utf8_lossy(&output.stdout);
	Some(texte.split_whitespace().next()?.parse::<u64>().ok()? * 1024)
}

/// Les dossiers régénérables d'un worktree, builds et dépendances séparés.
///
/// On ne descend jamais dans ce qu'on a trouvé : un `node_modules` contient des
/// milliers de `dist`, qui appartiennent aux paquets et non au projet.
pub fn rebuildable_dirs(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
	let mut builds = Vec::new();
	let mut deps = Vec::new();
	let mut walker = walkdir::WalkDir::new(root)
		.max_depth(SEARCH_DEPTH)
		.follow_links(false)
		.into_iter();

	while let Some(entry) = walker.next() {
		let Ok(entry) = entry else { continue };
		if !entry.file_type().is_dir() || entry.depth() == 0 {
			continue;
		}
		let nom = entry.file_name().to_string_lossy().to_string();
		// `.git` porte l'historique : on ne le mesure pas comme régénérable, et
		// on n'a rien à y chercher.
		if nom == ".git" {
			walker.skip_current_dir();
			continue;
		}
		if DEPENDENCIES.contains(&nom.as_str()) {
			deps.push(entry.path().to_path_buf());
			walker.skip_current_dir();
		} else if BUILDS.contains(&nom.as_str()) {
			builds.push(entry.path().to_path_buf());
			walker.skip_current_dir();
		}
	}
	(builds, deps)
}

/// Mesure un worktree, ou rend la mesure encore valable.
pub async fn disk_usage(path: &Path, refresh: bool) -> Option<DiskUsage> {
	let clé = path.to_string_lossy().to_string();
	if !refresh {
		if let Ok(cache) = usage_cache().lock() {
			if let Some(connu) = cache.get(&clé) {
				if chrono::Utc::now().timestamp() - connu.measured_at < MEASURE_TTL_SECONDS {
					return Some(connu.clone());
				}
			}
		}
	}
	if !path.is_dir() {
		return None;
	}

	let total = du_bytes(path).await?;
	let (builds, deps) = rebuildable_dirs(path);
	let mut poids_builds = 0;
	for dossier in &builds {
		poids_builds += du_bytes(dossier).await.unwrap_or(0);
	}
	let mut poids_deps = 0;
	for dossier in &deps {
		poids_deps += du_bytes(dossier).await.unwrap_or(0);
	}

	let mesure = DiskUsage {
		path: clé.clone(),
		bytes: total,
		builds: poids_builds,
		dependencies: poids_deps,
		measured_at: chrono::Utc::now().timestamp(),
	};
	if let Ok(mut cache) = usage_cache().lock() {
		cache.insert(clé, mesure.clone());
	}
	Some(mesure)
}

/// Mesure plusieurs worktrees, quelques-uns à la fois.
pub async fn disk_usages(paths: &[String], refresh: bool) -> Vec<DiskUsage> {
	let mut mesures = Vec::new();
	for lot in paths.chunks(PARALLEL_MEASURES) {
		let ensemble = lot
			.iter()
			.map(|path| disk_usage(Path::new(path), refresh))
			.collect::<Vec<_>>();
		mesures.extend(futures::future::join_all(ensemble).await.into_iter().flatten());
	}
	mesures
}

/// Efface ce qu'une commande sait reconstruire, et rend ce que ça a libéré.
///
/// `deps` dit s'il faut emporter aussi les dépendances installées. Les builds
/// partent toujours : les garder n'a de sens que pour qui va relancer le projet
/// tout de suite, et un worktree dont l'agent a fini n'attend plus personne.
///
/// Ne touche à rien d'autre — ni au code, ni à `.git`, ni à un fichier suivi. Ce
/// n'est pas une suppression de travail, c'est un dossier qu'on refera.
pub async fn purge_rebuildable(path: &Path, deps: bool) -> Result<u64> {
	if !path.is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"git.pathMissing",
			&[("path", &path.display())],
		)));
	}
	let (builds, dependencies) = rebuildable_dirs(path);
	let mut libéré = 0;
	let cibles = builds.into_iter().chain(if deps { dependencies } else { Vec::new() });
	for dossier in cibles {
		let poids = du_bytes(&dossier).await.unwrap_or(0);
		if std::fs::remove_dir_all(&dossier).is_ok() {
			libéré += poids;
		}
	}
	// La mesure en cache ne vaut plus rien.
	if let Ok(mut cache) = usage_cache().lock() {
		cache.remove(&path.to_string_lossy().to_string());
	}
	Ok(libéré)
}

pub async fn list_worktrees(main_repo: &Path) -> Result<Vec<Worktree>> {
	let raw = list_raw(main_repo).await?;

	// Chaque worktree est indépendant : on interroge git en parallèle plutôt
	// qu'en série, sinon 18 worktrees = 18 allers-retours séquentiels.
	let tasks = raw
		.into_iter()
		.enumerate()
		.map(|(index, (path, head, branch, detached, locked))| async move {
			let status = read_status(&path).await;
			let last_commit = read_last_commit(&path).await;
			let folder_name = path
				.file_name()
				.map(|n| n.to_string_lossy().to_string())
				.unwrap_or_default();
			let git_marker = path.join(".git");

			Worktree {
				path: path.to_string_lossy().to_string(),
				folder_name,
				branch,
				head,
				is_main: index == 0,
				is_detached: detached,
				is_locked: locked,
				status,
				last_activity: mtime_of(&git_marker).or_else(|| mtime_of(&path)),
				last_commit,
			}
		});

	Ok(futures::future::join_all(tasks).await)
}

pub async fn recent_commits(path: &Path, limit: usize) -> Result<Vec<Commit>> {
	let raw = run_git(
		path,
		&["log", &format!("-{limit}"), "--format=%h%x1f%s%x1f%an%x1f%ar%x1f%at"],
	)
	.await?;
	Ok(raw.lines().filter_map(parse_commit_line).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
	pub path: String,
	pub added: usize,
	pub removed: usize,
	pub state: String,
}

/// Diff du worktree vs sa base (HEAD), fichiers non suivis inclus — c'est la
/// vue « qu'est-ce que l'agent a réellement produit ici ».
pub async fn working_diff(path: &Path) -> Result<Vec<FileChange>> {
	let mut changes = Vec::new();

	if let Ok(raw) = run_git(path, &["diff", "HEAD", "--numstat"]).await {
		for line in raw.lines() {
			let mut parts = line.split('\t');
			let added = parts.next().unwrap_or("0").parse().unwrap_or(0);
			let removed = parts.next().unwrap_or("0").parse().unwrap_or(0);
			let Some(file) = parts.next() else { continue };
			changes.push(FileChange {
				path: file.to_string(),
				added,
				removed,
				state: "modified".into(),
			});
		}
	}

	if let Ok(raw) = run_git(path, &["ls-files", "--others", "--exclude-standard"]).await {
		for file in raw.lines().filter(|l| !l.trim().is_empty()) {
			changes.push(FileChange {
				path: file.to_string(),
				added: 0,
				removed: 0,
				state: "untracked".into(),
			});
		}
	}

	Ok(changes)
}

pub async fn file_diff(path: &Path, file: &str) -> Result<String> {
	run_git(path, &["diff", "HEAD", "--", file]).await
}

// ───────────────────────────── Vue par branche ─────────────────────────────
//
// Les worktrees répondent à « où en est cet arbre de travail ». Cette partie
// répond à l'autre question, celle qu'on se pose devant un historique : « qu'est-ce
// que cette branche change, au juste ». Tout est donc mesuré depuis le point de
// divergence avec la branche de base, jamais depuis la pointe de celle-ci : sinon
// les commits arrivés sur `main` entre-temps polluent le diff.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
	pub name: String,
	/// Branche pointée par le HEAD du dépôt principal.
	pub is_current: bool,
	pub is_default: bool,
	/// Worktree dans lequel la branche est sortie, s'il y en a un.
	pub worktree_path: Option<String>,
	pub upstream: Option<String>,
	/// Position vis-à-vis de l'upstream (ce qui reste à pousser / tirer).
	pub ahead: usize,
	pub behind: usize,
	/// Commits propres à la branche, comptés depuis la divergence avec la base.
	pub commits_ahead: usize,
	/// Cette branche n'existe que sur le serveur — personne ne l'a sortie ici.
	///
	/// C'est le cas de la branche d'un collègue qu'on vient relire : elle n'a ni
	/// worktree, ni avancement local, et il faut d'abord la sortir pour y
	/// travailler.
	pub remote_only: bool,
	/// Le serveur qui la porte (`origin`), quand elle vient de là.
	pub remote: String,
	pub last_commit: Option<Commit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOverview {
	/// Branche de référence effectivement utilisée pour les comparaisons.
	pub base: String,
	pub branches: Vec<Branch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
	pub branch: String,
	pub base: String,
	/// Commit de divergence : la référence de tous les chiffres affichés.
	pub merge_base: String,
	pub files: Vec<FileChange>,
	pub commits: Vec<Commit>,
	pub additions: usize,
	pub deletions: usize,
}

/// Le `propriétaire/dépôt` que porte le remote, quand c'en est un de GitHub.
///
/// La configuration réclame cette forme, et un message qui se contente de la
/// rappeler laisse chercher : le dépôt est là, sous la main, avec la réponse
/// dans son remote. Autant la lire et la proposer telle quelle.
///
/// Les deux écritures d'URL sont couvertes — `https://github.com/o/d.git`,
/// identifiant inclus, et `git@github.com:o/d.git`.
pub async fn github_slug(repo: &Path) -> Option<String> {
	let url = run_git(repo, &["remote", "get-url", "origin"]).await.ok()?;
	Some(slug_from_remote(url.trim())).filter(|slug| !slug.is_empty())
}

/// `propriétaire/dépôt` lu dans une adresse de serveur.
///
/// Séparé de [`github_slug`] pour servir aussi quand on tient déjà l'adresse et
/// qu'on ne veut pas relancer `git` : l'écran de création inspecte un dossier
/// une fois et se sert du résultat plusieurs fois.
pub fn slug_from_remote(url: &str) -> String {
	let url = url.trim();
	let reste = match url.split_once("github.com") {
		Some((_, reste)) => reste.trim_start_matches([':', '/']),
		None => return String::new(),
	};
	let slug = reste
		.trim_start_matches([':', '/'])
		.trim_end_matches(".git")
		.trim_end_matches('/');
	let Some((owner, name)) = slug.split_once('/') else {
		return String::new();
	};
	// Un chemin plus profond n'est pas un dépôt : on ne devine pas.
	if owner.is_empty() || name.is_empty() || name.contains('/') {
		return String::new();
	}
	format!("{owner}/{name}")
}

/// Crée une branche sans la sortir : le dossier de travail ne bouge pas.
///
/// Demandée à voix haute (« crée-moi une branche fix/cart-rounding »), elle part
/// de la branche d'intégration quand rien d'autre n'est dit. Le nom passe par
/// `git check-ref-format` avant tout : une transcription qui glisse une espace
/// ou un accent ne doit pas créer une référence que git refuserait plus tard.
pub async fn create_branch(repo: &Path, name: &str, base: Option<&str>) -> Result<String> {
	let name = name.trim();
	run_git(repo, &["check-ref-format", "--branch", name])
		.await
		.map_err(|_| CockpitError::msg(crate::i18n::tf("git.invalidBranchName", &[("name", &name)])))?;
	if run_git(
		repo,
		&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")],
	)
	.await
	.is_ok()
	{
		return Err(CockpitError::msg(crate::i18n::tf(
			"git.branchExists",
			&[("name", &name)],
		)));
	}
	let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
		Some(base) => base.to_string(),
		// La branche d'intégration telle qu'elle est publiée, pas telle qu'on
		// l'a laissée sur le poste : partir d'un `dev` périmé, c'est démarrer en
		// retard et embarquer des conflits.
		None => freshest(repo, &default_branch(repo).await).await,
	};
	// Sans suivi : une branche créée depuis `origin/dev` le suivrait, et un
	// simple `git push` voudrait alors pousser sur `dev`.
	run_git(repo, &["branch", "--no-track", "--end-of-options", name, &base]).await?;
	Ok(crate::i18n::tf(
		"git.branchCreated",
		&[("name", &name), ("base", &base)],
	))
}

/// La version la plus à jour d'une branche, pour **comparer** contre elle.
///
/// Un `dev` local qu'on n'a pas mis à jour depuis des jours reste en arrière de
/// `origin/dev`, où les autres fusionnent. Comparer une branche partie du `dev`
/// publié à ce `dev` local fait entrer dans la comparaison tout ce qui a été
/// fusionné entre-temps : les changements des autres, présentés comme les
/// siens (vu sur la visite des changements, 30 commits en trop).
///
/// La copie publiée l'emporte quand la locale n'en est qu'un ancêtre ; une
/// locale qui porte des commits pas encore poussés reste la référence. Pour
/// **nommer** une branche — la cible d'une PR, la base d'une mission — on garde
/// le nom tel que [`default_branch`] le rend.
pub async fn freshest(repo: &Path, name: &str) -> String {
	let remote = format!("origin/{name}");
	if run_git(repo, &["rev-parse", "--verify", "--quiet", &remote])
		.await
		.is_err()
	{
		return name.to_string();
	}
	if run_git(repo, &["rev-parse", "--verify", "--quiet", name])
		.await
		.is_err()
	{
		return remote;
	}
	if run_git(repo, &["merge-base", "--is-ancestor", name, &remote])
		.await
		.is_ok()
	{
		remote
	} else {
		name.to_string()
	}
}

/// Branche de base du dépôt : celle vers laquelle les autres sont comparées.
///
/// `origin/HEAD` désigne la branche de publication, qui n'est pas toujours celle
/// sur laquelle le travail s'intègre : là où les features partent de `dev` et où
/// `main` ne reçoit que les mises en production, comparer à `main` fait
/// apparaître des milliers de fichiers qui n'ont rien à voir avec la branche
/// qu'on regarde. On retient donc, parmi les noms d'intégration usuels présents
/// dans le dépôt, celui dont l'historique est le plus avancé.
pub async fn default_branch(repo: &Path) -> String {
	let published = run_git(repo, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
		.await
		.ok()
		.and_then(|raw| raw.trim().strip_prefix("refs/remotes/origin/").map(str::to_string))
		.filter(|name| !name.is_empty());

	let mut candidates: Vec<String> = ["dev", "develop", "main", "master"]
		.iter()
		.map(|name| name.to_string())
		.collect();
	if let Some(name) = published.clone() {
		if !candidates.contains(&name) {
			candidates.push(name);
		}
	}

	let measured = futures::future::join_all(candidates.into_iter().map(|name| async move {
		let count: usize = run_git(repo, &["rev-list", "--count", &name])
			.await
			.ok()
			.and_then(|raw| raw.trim().parse().ok())
			.unwrap_or(0);
		(name, count)
	}))
	.await;

	measured
		.into_iter()
		.filter(|(_, count)| *count > 0)
		.max_by_key(|(_, count)| *count)
		.map(|(name, _)| name)
		.or(published)
		.unwrap_or_else(|| "main".into())
}

/// `%(upstream:track)` rend « [ahead 2, behind 3] », « [gone] » ou du vide.
fn parse_track(raw: &str) -> (usize, usize) {
	let mut ahead = 0;
	let mut behind = 0;
	for part in raw.trim_matches(['[', ']']).split(", ") {
		if let Some(value) = part.strip_prefix("ahead ") {
			ahead = value.parse().unwrap_or(0);
		} else if let Some(value) = part.strip_prefix("behind ") {
			behind = value.parse().unwrap_or(0);
		}
	}
	(ahead, behind)
}

const BRANCH_FIELDS: [&str; 11] = [
	// Le nom complet vient en premier : lui seul dit sans ambiguïté de quel
	// espace de noms vient la référence. Le déduire du nom court reviendrait à
	// parier qu'aucune branche locale ne s'appelle `origin/quelque-chose`.
	"%(refname)",
	"%(refname:short)",
	"%(HEAD)",
	"%(worktreepath)",
	"%(upstream:short)",
	"%(upstream:track)",
	"%(objectname:short)",
	"%(contents:subject)",
	"%(authorname)",
	"%(committerdate:relative)",
	"%(committerdate:unix)",
];

/// Le catalogue des branches, locales et — sur demande — distantes.
///
/// `include_remote` ajoute les branches qui n'existent que sur le serveur :
/// celles qu'un collègue a poussées et qu'on n'a jamais sorties ici. Sans
/// elles, coller le nom d'une branche à relire ne donnait « aucun résultat »
/// partout dans le cockpit — il fallait deviner qu'elle existait, et passer par
/// la création de worktree pour la voir apparaître. Elles portent leur nom
/// court (`fix/…`, sans le `origin/`) : c'est celui qu'on colle, et celui dont
/// la création de worktree a besoin.
pub async fn list_branches(repo: &Path, base: &str, include_remote: bool) -> Result<Vec<Branch>> {
	const SEP: char = '\u{1f}';

	// Un seul `for-each-ref` pour tout le catalogue, `%(ahead-behind:)` compris.
	// Ce dépôt a près de trois cents branches : compter les commits une branche
	// à la fois, ce serait autant de processus git pour une liste qui doit
	// s'afficher instantanément. git sait le faire en une passe — depuis 2.41
	// seulement, d'où le repli plus bas.
	let with_counts = format!(
		"--format={}{SEP}%(ahead-behind:{base})",
		BRANCH_FIELDS.join(&SEP.to_string())
	);
	let plain = format!("--format={}", BRANCH_FIELDS.join(&SEP.to_string()));

	// Les deux espaces de noms dans le même appel quand on veut les deux : git
	// trie alors l'ensemble, et la branche qu'un collègue vient de pousser
	// remonte au-dessus d'une locale oubliée — l'ordre dans lequel on cherche.
	let mut spaces: Vec<&str> = vec!["refs/heads"];
	if include_remote {
		spaces.push("refs/remotes");
	}

	let mut args: Vec<&str> = vec!["for-each-ref", "--sort=-committerdate", &with_counts];
	args.extend(spaces.iter().copied());
	let (raw, has_counts) = match run_git(repo, &args).await {
		Ok(raw) => (raw, true),
		Err(_) => {
			let mut fallback: Vec<&str> = vec!["for-each-ref", "--sort=-committerdate", &plain];
			fallback.extend(spaces.iter().copied());
			(run_git(repo, &fallback).await?, false)
		}
	};

	let ligne_champs = |line: &str| -> Option<Vec<String>> {
		let fields: Vec<String> = line.split(SEP).map(|f| f.to_string()).collect();
		(fields.len() >= BRANCH_FIELDS.len()).then_some(fields)
	};

	// Les branches locales, par nom : une distante qui a son pendant local n'est
	// pas une entrée de plus — c'est la même, et c'est la locale qui porte le
	// worktree, l'avancement et le suivi.
	let locales: std::collections::HashSet<String> = raw
		.lines()
		.filter_map(ligne_champs)
		.filter(|fields| fields[0].starts_with("refs/heads/"))
		.map(|fields| fields[1].clone())
		.collect();

	Ok(raw
		.lines()
		.filter(|line| !line.trim().is_empty())
		.filter_map(|line| {
			let fields = ligne_champs(line)?;

			let refname = &fields[0];
			let court = fields[1].clone();
			let remote_only = refname.starts_with("refs/remotes/");
			// `%(refname:short)` rend `origin/fix/x` pour une distante : on retire
			// le remote pour ne garder que ce qu'on colle et ce que la création de
			// worktree attend.
			let (remote, name) = if remote_only {
				match court.split_once('/') {
					Some((tete, reste)) => (tete.to_string(), reste.to_string()),
					None => (String::new(), court.clone()),
				}
			} else {
				(String::new(), court.clone())
			};

			if remote_only {
				// `origin/HEAD` n'est pas une branche mais un pointeur vers celle
				// par défaut : l'afficher ferait un doublon qui ne se sort pas.
				if name == "HEAD" || locales.contains(&name) {
					return None;
				}
			}

			let (ahead, behind) = parse_track(&fields[5]);
			// « <ahead> <behind> » vis-à-vis de la base ; vide si la référence
			// n'est pas comparable (base absente du dépôt, par exemple).
			let commits_ahead = if has_counts {
				fields
					.get(BRANCH_FIELDS.len())
					.and_then(|value| value.split_whitespace().next())
					.and_then(|value| value.parse().ok())
					.unwrap_or(0)
			} else {
				0
			};

			Some(Branch {
				is_current: fields[2] == "*",
				is_default: name == base,
				worktree_path: Some(fields[3].clone()).filter(|p| !p.is_empty()),
				upstream: Some(fields[4].clone()).filter(|u| !u.is_empty()),
				ahead,
				behind,
				commits_ahead,
				last_commit: Some(Commit {
					sha: fields[6].clone(),
					subject: fields[7].clone(),
					author: fields[8].clone(),
					relative: fields[9].clone(),
					timestamp: fields[10].parse().unwrap_or(0),
				}),
				remote,
				remote_only,
				name,
			})
		})
		.collect())
}

/// Statuts `git diff --name-status` ramenés au vocabulaire de l'UI.
fn state_label(code: &str) -> &'static str {
	match code.chars().next() {
		Some('A') => "added",
		Some('D') => "deleted",
		Some('R') => "renamed",
		Some('C') => "copied",
		_ => "modified",
	}
}

/// Les noms de branche passent derrière `--end-of-options` : ils viennent du
/// dépôt distant ou de l'interface, et un nom qui commence par `-`
/// (`--output=…`) serait sinon lu par git comme une option.
pub async fn branch_diff(repo: &Path, branch: &str, base: &str) -> Result<BranchDiff> {
	// Sans point de divergence commun (branche orpheline), il n'y a rien de
	// sensé à comparer : on le dit plutôt que d'afficher tout le dépôt en ajout.
	let merge_base = run_git(repo, &["merge-base", "--end-of-options", base, branch])
		.await
		.map(|raw| raw.trim().to_string())
		.map_err(|_| {
			CockpitError::msg(crate::i18n::tf(
				"git.noCommonAncestor",
				&[("branch", &branch), ("base", &base)],
			))
		})?;

	let range = format!("{merge_base}..{branch}");

	// Les états viennent de `--name-status`, les volumes de `--numstat` : deux
	// passes sur le même diff, recoupées par chemin.
	let mut states = std::collections::HashMap::new();
	if let Ok(raw) = run_git(
		repo,
		&["diff", "--name-status", "--end-of-options", &merge_base, branch],
	)
	.await
	{
		for line in raw.lines() {
			let mut parts = line.split('\t');
			let Some(code) = parts.next() else { continue };
			// Un rename liste l'ancien puis le nouveau chemin : c'est le nouveau
			// qui existe encore, donc le seul qu'on puisse ouvrir.
			let Some(path) = parts.next_back() else { continue };
			states.insert(path.to_string(), state_label(code));
		}
	}

	let mut files = Vec::new();
	let mut additions = 0;
	let mut deletions = 0;
	if let Ok(raw) = run_git(repo, &["diff", "--numstat", "--end-of-options", &merge_base, branch]).await {
		for line in raw.lines() {
			let mut parts = line.split('\t');
			// « - » à la place des chiffres signale un fichier binaire.
			let added = parts.next().unwrap_or("0").parse().unwrap_or(0);
			let removed = parts.next().unwrap_or("0").parse().unwrap_or(0);
			let Some(path) = parts.next() else { continue };
			additions += added;
			deletions += removed;
			files.push(FileChange {
				path: path.to_string(),
				added,
				removed,
				state: states.get(path).copied().unwrap_or("modified").to_string(),
			});
		}
	}

	let commits_raw = run_git(
		repo,
		&[
			"log",
			"--format=%h%x1f%s%x1f%an%x1f%ar%x1f%at",
			"--end-of-options",
			&range,
		],
	)
	.await
	.unwrap_or_default();

	Ok(BranchDiff {
		branch: branch.to_string(),
		base: base.to_string(),
		merge_base,
		files,
		commits: commits_raw.lines().filter_map(parse_commit_line).collect(),
		additions,
		deletions,
	})
}

pub async fn branch_file_diff(repo: &Path, branch: &str, base: &str, file: &str) -> Result<String> {
	let merge_base = run_git(repo, &["merge-base", "--end-of-options", base, branch])
		.await
		.map(|raw| raw.trim().to_string())?;
	run_git(repo, &["diff", "--end-of-options", &merge_base, branch, "--", file]).await
}

/// Graphe ASCII des dernières révisions, tel que `git log --graph` le dessine.
/// Reproduire un rendu de graphe en React coûterait cher pour un résultat moins
/// lisible que celui de git lui-même.
pub async fn branch_graph(repo: &Path, refs: &[String], limit: usize) -> Result<String> {
	let mut args = vec![
		"log".to_string(),
		"--graph".to_string(),
		"--date-order".to_string(),
		format!("-{limit}"),
		"--format=%h\u{1f}%s\u{1f}%an\u{1f}%ar\u{1f}%d".to_string(),
	];
	args.extend(refs.iter().cloned());

	let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
	run_git(repo, &borrowed).await
}

#[cfg(test)]
mod slug_tests {
	/// Le découpage des deux écritures d'URL, isolé du disque : c'est lui qui
	/// décide de ce que le message proposera de taper.
	fn slug_de(url: &str) -> Option<String> {
		let reste = url.trim().split_once("github.com")?.1.trim_start_matches([':', '/']);
		let slug = reste.trim_end_matches(".git").trim_end_matches('/');
		let (owner, name) = slug.split_once('/')?;
		if owner.is_empty() || name.is_empty() || name.contains('/') {
			return None;
		}
		Some(format!("{owner}/{name}"))
	}

	#[test]
	fn les_ecritures_d_url_donnent_le_meme_depot() {
		for url in [
			"https://github.com/jodevweb/cockpit.git",
			// Avec l'identifiant devant l'hôte, ce que `gh` écrit souvent.
			"https://jodevweb@github.com/jodevweb/cockpit.git",
			"git@github.com:jodevweb/cockpit.git",
			"https://github.com/jodevweb/cockpit",
		] {
			assert_eq!(slug_de(url).as_deref(), Some("jodevweb/cockpit"), "sur {url}");
		}
	}

	#[test]
	fn ce_qui_n_est_pas_un_depot_github_ne_propose_rien() {
		assert_eq!(slug_de("git@gitlab.com:groupe/produit.git"), None);
		// Un propriétaire sans dépôt : rien à suggérer plutôt qu'une valeur fausse.
		assert_eq!(slug_de("https://github.com/jodevweb"), None);
	}
}

#[cfg(test)]
mod usage_tests {
	use super::*;

	/// Un worktree de monorepo en miniature : un build au fond d'une app, des
	/// dépendances à la racine, et les pièges qu'il ne faut pas confondre avec.
	fn faux_worktree(nom: &str) -> PathBuf {
		let racine = std::env::temp_dir().join(format!("cockpit-usage-{}-{nom}", std::process::id()));
		let _ = std::fs::remove_dir_all(&racine);
		let p = racine.as_path();
		for chemin in [
			"apps/web/.next/static",
			"apps/web/src",
			"node_modules/.pnpm/react/dist",
			"packages/ui/dist",
			".git/objects",
			// Le piège : un `dist` qui appartient à une dépendance, pas au
			// projet. L'effacer casserait l'installation.
			"node_modules/lodash/dist",
		] {
			std::fs::create_dir_all(p.join(chemin)).unwrap();
		}
		racine
	}

	#[test]
	fn trouve_les_builds_sans_descendre_dans_les_dépendances() {
		let racine = faux_worktree("builds");
		let (builds, deps) = rebuildable_dirs(&racine);

		let noms: Vec<String> = builds
			.iter()
			.map(|p| p.strip_prefix(&racine).unwrap().to_string_lossy().replace('\\', "/"))
			.collect();
		assert!(noms.contains(&"apps/web/.next".to_string()));
		assert!(noms.contains(&"packages/ui/dist".to_string()));
		// Ceux-là appartiennent aux paquets installés : on ne descend jamais
		// dans `node_modules`, sinon on effacerait l'installation elle-même.
		assert!(
			!noms.iter().any(|nom| nom.contains("node_modules")),
			"rien de ce qui vit sous node_modules ne doit être listé : {noms:?}"
		);
		assert_eq!(deps.len(), 1, "une seule racine de dépendances");
	}

	#[test]
	fn ne_touche_jamais_à_lhistorique() {
		let racine = faux_worktree("historique");
		let (builds, deps) = rebuildable_dirs(&racine);
		for chemin in builds.iter().chain(deps.iter()) {
			assert!(
				!chemin.to_string_lossy().contains(".git"),
				"{} : l'historique n'est pas régénérable",
				chemin.display()
			);
		}
	}

	#[tokio::test]
	async fn vider_les_builds_laisse_le_code_et_les_dépendances() {
		let p = faux_worktree("vidage");
		std::fs::write(p.join("apps/web/src/page.tsx"), "export default 1").unwrap();

		purge_rebuildable(&p, false).await.unwrap();

		assert!(!p.join("apps/web/.next").exists(), "le build s'en va");
		assert!(p.join("apps/web/src/page.tsx").exists(), "le code reste");
		assert!(p.join("node_modules").exists(), "les dépendances restent");
		assert!(p.join(".git").exists(), "l'historique reste");
	}

	#[tokio::test]
	async fn les_dépendances_ne_partent_que_si_on_le_demande() {
		let p = faux_worktree("deps");
		purge_rebuildable(&p, true).await.unwrap();
		assert!(!p.join("node_modules").exists());
		assert!(p.join(".git").exists(), "l'historique reste, toujours");
	}
}
