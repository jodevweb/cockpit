import clsx from "clsx";

/**
 * L'horizon artificiel du cockpit, en vectoriel.
 *
 * Le même dessin que l'icône de l'application — l'instrument qui dit d'un regard
 * si l'on vole à plat. Il était jusqu'ici servi par un PNG figé, jamais remis à
 * jour quand l'icône a changé : l'app portait deux identités, celle du dock et
 * celle de sa propre barre.
 *
 * En vectoriel il reste net à toute taille et suit l'accent du thème, ce qu'un
 * PNG ne sait pas faire. Et il tourne, très lentement : un poste de pilotage
 * vivant a des instruments qui bougent, mais un logo qui s'agite fatigue en
 * trente secondes — l'horizon dérive de deux degrés, comme un appareil stable.
 *
 * **Deux calques, et c'est la raison d'être de cette forme.** Le dessin tenait
 * dans un seul SVG, la dérive portée par un groupe intérieur. WebKit ne sait
 * pas confier au compositeur la transformation d'un élément *dans* un SVG : il
 * la recalculait sur le fil principal, ce qui déclenchait une résolution de
 * style et un calcul de disposition du document entier à chaque image, soixante
 * fois par seconde, sur tous les écrans — le logo vit dans la barre latérale.
 * Mesuré : dix pour cent d'un cœur sur un écran immobile, et davantage à mesure
 * qu'une conversation s'allonge, puisque le document grossit avec elle.
 *
 * En sortant l'horizon dans son propre SVG, l'animation porte sur un élément de
 * niveau document, que le compositeur sait prendre en charge seul. Le fil
 * principal ne fait plus rien. Le dessin, lui, est identique : le repère fixe
 * reste par-dessus, la dérive reste dessous, et le cadran découpe toujours au
 * même endroit.
 */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
	return (
		<span
			className={clsx("logo-cadre", className)}
			style={{ width: size, height: size }}
			aria-hidden
		>
			{/* La dérive : deux degrés de part et d'autre, sur seize secondes.
			    Assez pour que l'instrument paraisse vivant, trop lent pour qu'on
			    le remarque en travaillant. */}
			<svg viewBox="0 0 1024 1024" className="logo-derive">
				<defs>
					<linearGradient id="logo-ciel" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="var(--accent-soft)" />
						<stop offset="1" stopColor="var(--accent)" />
					</linearGradient>
				</defs>
				<rect x="112" y="12" width="800" height="500" fill="url(#logo-ciel)" />
				<rect x="112" y="512" width="800" height="500" className="fill-accent-dim" />
				<rect x="92" y="502" width="840" height="10" className="fill-ink" opacity="0.9" />
			</svg>

			{/* Le repère fixe ne dérive pas : c'est le point de vue de qui pilote. */}
			<svg viewBox="0 0 1024 1024" className="logo-repere">
				<circle
					cx="512"
					cy="512"
					r="322"
					fill="none"
					className="stroke-ink"
					strokeOpacity="0.14"
					strokeWidth="16"
				/>
				<g className="stroke-ink" strokeWidth="30" strokeLinecap="round" fill="none">
					<path d="M 268 512 H 356" />
					<path d="M 668 512 H 756" />
				</g>
				<circle cx="512" cy="512" r="24" className="fill-ink" />
			</svg>
		</span>
	);
}
