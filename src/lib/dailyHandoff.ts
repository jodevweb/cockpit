/**
 * « Présenter au daily » depuis le rendu d'une automatisation.
 *
 * L'écran Daily ouvre son mode présentation lui-même, une fois son équipe
 * chargée : on ne fait que laisser la demande, qu'il consomme au montage.
 */

let pending = false;

export function requestDailyPresentation(): void {
	pending = true;
}

export function consumeDailyPresentation(): boolean {
	const asked = pending;
	pending = false;
	return asked;
}
