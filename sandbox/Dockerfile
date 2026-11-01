# Image par défaut de l'isolation d'agent (Réglages → Isolation des agents).
#
# Le cockpit ne la construit pas lui-même : Docker ou OrbStack ne sont pas
# des prérequis tant que l'isolation reste éteinte, et une image construite
# en silence au premier lancement surprendrait plus qu'elle n'aiderait.
#
#   docker build -t cockpit-agent:latest sandbox/
#
# Le strict nécessaire pour faire tourner un agent et ses ponts MCP : le CLI
# `claude`, node (pour les ponts), git (pour les commits), zsh (le shell
# que le cockpit invoque). Rien de plus — pas de compilateurs, pas de
# runtime de projet : le worktree monté apporte le sien.
FROM node:22-alpine

# `github-cli` : sans lui, un agent isolé ne peut ni lire une pull request, ni
# en ouvrir une — il le dit lui-même et prépare le travail pour qu'on le colle à
# sa place. Le jeton, lui, arrive par l'environnement (voir `sandbox.rs`).
RUN apk add --no-cache git openssh-client zsh bash curl github-cli \
	&& npm install -g @anthropic-ai/claude-code

WORKDIR /work
