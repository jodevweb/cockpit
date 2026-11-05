# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cockpit is a Tauri 2 desktop app (macOS, Windows, Linux) that drives coding-agent CLIs already installed on the machine (`claude`, plus `codex` and `gemini`) across git worktrees. Rust (`src-tauri/`) does everything that touches the system: git, processes, files, HTTP. React + Tailwind (`src/`) is the interface. There is no server: config, missions and agent state live on disk under `~/.config/cockpit/`.

## Commands

```bash
pnpm install
pnpm dev                          # the app, hot reload (tauri dev)
pnpm vite:dev                     # the interface alone in a browser, on preview data
pnpm install:app                  # build + install locally (scripts/plateforme.mjs picks .sh or .ps1)

pnpm exec tsc --noEmit            # types
node scripts/i18n-check.mjs       # translation catalogs (optionally: <language>)
pnpm test:ui                      # Playwright, against the preview (vite on port 41730)
pnpm exec playwright test -g "<test name>"   # a single UI test

cd src-tauri && cargo test --lib                  # Rust tests
cd src-tauri && cargo test --lib orchestrator::   # one module
cd src-tauri && cargo test --lib <module>::tests::<name>   # one test
```

These are the checks the CI runs on every PR (macOS, Windows, Linux, and Playwright on Linux). On Windows, the OpenSSL build needs Strawberry Perl: `OPENSSL_SRC_PERL=C:/Strawberry/perl/bin/perl.exe`.

`node scripts/cli-contract.mjs` checks that the `claude` CLI options Cockpit passes still exist. It runs nightly in CI against the latest published CLI.

## Things that are easy to get wrong

- **Generated types.** Rust types shared with the UI derive `ts-rs` (`#[cfg_attr(test, ts(export))]`). `cargo test` rewrites `src/lib/generated/`, and the CI fails if those files differ from what is committed. After changing such a type, run `cargo test` and commit the regenerated files.
- **Preview mode.** Outside the native window, in dev, `src/lib/ipc.ts` answers every command from canned data in `src/lib/preview.ts` (`REPONSES`, keyed by command name). Playwright runs against this. A new IPC command needs a preview answer, or its screen breaks in the preview and in the UI tests.
- **Adding an IPC command** touches three places: the `#[tauri::command]` function, its registration in `tauri::generate_handler![…]` in `src-tauri/src/lib.rs`, and a typed wrapper in the `api` object of `src/lib/ipc.ts`.
- **Translations.** UI strings live in `src/locales/<lang>/*.json` (i18next). Texts produced by Rust and the mobile page live in `src-tauri/locales/<lang>/`. There are ten languages and English is the reference. Every new key goes into all ten; `i18n-check` lists what is missing.
- **Line endings.** On a Windows checkout, the working copy is CRLF (`core.autocrlf`), except `src/lib/generated/**`, which is LF (`.gitattributes`). Scripted search-and-replace must match `\r\n`. A Windows build rewrites `src-tauri/gen/schemas/*.json` and `Cargo.toml` with different line endings only: restore them, don't commit them.
- **Paths on Windows.** The same folder appears as `D:\x`, `D:/x` or `\\?\D:\x` depending on its source (CLI session files, config, canonicalize). Compare normalized paths: `platform::path_key`/`plain_path` in Rust, `folderKey` in `src/lib/missions.ts`.

## Architecture

**Agents** (`agent.rs`, `protocol.rs`, `codex.rs`, `gemini.rs`). An agent is a CLI process driven in stream-json mode: Cockpit writes to its stdin and parses its stdout into turns. `protocol.rs` turns the configured protocol string into an enum, so that every protocol branch is an exhaustive `match`.
- **Relay** (`relay.rs`): the CLI reads `in.jsonl` and writes `out.jsonl`. Agents therefore survive the app closing or updating. On startup, `agent::adopt_relays` reattaches the ones still alive.
- **Tool permissions** (`permissions.rs`): the CLI's `--permission-prompt-tool` points at a tiny MCP tool. It drops each request in a folder, which the app watches and answers.
- **Executions** (`executions.rs`): what each agent did, recorded as an on-disk ledger.

**Missions** (`mission.rs`, `mission_commands.rs`, `orchestrator.rs`, `gates.rs`): a ticket becomes a lead ("master") agent, then a plan, then tasks. Each task has its role, branch and worktree, branched from an integration branch.
- `mission.rs` only holds the state and persists it (`~/.config/cockpit/missions/`). It never launches or merges anything.
- Guided missions stop for human approval at each step: `awaitingUnderstanding` → `awaitingApproach` → `awaitingApproval`.
- `orchestrator.rs` prepares the worktrees and merges delivered tasks into the integration branch. A task is merged only once the repository's gates (`gates.rs`) pass on an exit code, not on what the agent claims.
- On startup, `lib.rs` recovers interrupted missions and relaunches their masters before starting the watchers.

**Config** (`config.rs`): one TOML file, `~/.config/cockpit/config.toml`, with global sections plus `projects`. Which reader to use matters:
- `Config::load()`: the raw file. Use it for anything that writes back.
- `Config::active()`: the active project's view, where project settings override the global ones.
- `Config::for_repo(path)`: the view of the project that owns a repository. Background work (missions, workers) must use this, not `active()`.

**Frontend.** `src/app/` holds the shell and global state as React providers, nested in `App.tsx`:
- `store.tsx` (`useCockpit`): config, worktrees, missions, navigation;
- `agents.tsx` (`useAgentRuns`): the live agent runs and their turns;
- `terminals.tsx`, `workspace.tsx`;
- `hibernate.tsx`: reopens workspaces at startup.

`src/views/` has one file per screen. `src/lib/` holds the IPC layer, the generated types and helpers. The "waiting on you" list is computed once in `src/app/blockers.tsx`, and both the map and the Today screen use it.

## Conventions

- Source code and comments are in French. Comments explain why, often with the incident that motivated the code. Keep that style.
- `main` is protected: one branch and one PR per change, green CI required, no history rewriting. Releases (`docs/RELEASING.md`) are tag-driven (`vX.Y.Z` triggers `release.yml`) and reserved to the maintainer.
- The repository is public. Design notes, plans and working documents stay out of it.
