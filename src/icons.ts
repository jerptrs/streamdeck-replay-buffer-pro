/**
 * SVG artwork for every key face, action-list icon and plugin icon.
 *
 * This module has no imports so `scripts/render-icons.ts` can load it directly with Node's
 * type stripping. The script rasterises everything to PNG, so the plugin never depends on how
 * the Stream Deck app renders SVG text.
 */

/** Clip lengths in seconds; the same as Replay Buffer Pro's default buttons. */
export const SAVE_DURATIONS = [15, 30, 60, 300, 900, 1800] as const;
export type SaveDuration = (typeof SAVE_DURATIONS)[number];

export const SAVE_VARIANTS = ["ready", "inactive", "offline", "saving", "saved"] as const;
export type SaveVariant = (typeof SAVE_VARIANTS)[number];

export const TOGGLE_VARIANTS = ["on", "off", "starting", "stopping", "offline", "unavailable"] as const;
export type ToggleVariant = (typeof TOGGLE_VARIANTS)[number];

/**
 * Faces shown while a saved clip is uploaded to chibisafe: progress in 10% steps, and "copied" once
 * the link is on the clipboard. They look the same on every save key.
 */
export const UPLOAD_VARIANTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, "copied"] as const;
export type UploadVariant = (typeof UPLOAD_VARIANTS)[number];

const SIZE = 144;
const CX = 72;
const RING_CY = 58;
const RING_R = 34;
const FONT = "Arial, Helvetica, sans-serif";

const WHITE = "#ffffff";
const MUTED = "#5b6273";
const MUTED_TEXT = "#8a91a3";
const RED = "#ff3b47";
const AMBER = "#ffb020";
const GREEN = "#34d399";
const BLUE = "#60a5fa";

/** Accent colour per clip length, so the save keys are easy to tell apart at a glance. */
const DURATION_ACCENT: Record<SaveDuration, string> = {
	15: "#38bdf8",
	30: "#a78bfa",
	60: "#fb923c",
	300: "#f472b6",
	900: "#facc15",
	1800: "#a3e635",
};

/** Key file name (without size suffix) for a save key face. */
export function saveKeyName(duration: SaveDuration, variant: SaveVariant): string {
	return `save-${duration}-${variant}`;
}

/** Key file name (without size suffix) for an upload face. */
export function uploadKeyName(variant: UploadVariant): string {
	return `upload-${variant}`;
}

/** Key file name (without size suffix) for a toggle key face. */
export function toggleKeyName(variant: ToggleVariant): string {
	return `toggle-${variant}`;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
	const rad = (deg * Math.PI) / 180;
	return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function fmt(n: number): string {
	return n.toFixed(2);
}

/**
 * A "replay" ring: an almost-closed circle whose arrowhead sits at 12 o'clock and points
 * anti-clockwise, i.e. "back in time". The gap sits in the upper-left quadrant.
 */
function replayRing(cx: number, cy: number, r: number, stroke: string, width: number, dashed = false): string {
	const start = -90;
	const end = 205;
	const [x1, y1] = polar(cx, cy, r, start);
	const [x2, y2] = polar(cx, cy, r, end);
	const dash = dashed ? ` stroke-dasharray="${fmt(width * 1.1)} ${fmt(width * 1.25)}"` : "";
	const arc = `<path d="M ${fmt(x1)} ${fmt(y1)} A ${r} ${r} 0 1 1 ${fmt(x2)} ${fmt(y2)}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${dash}/>`;

	// Arrowhead at the top of the ring, pointing left (anti-clockwise).
	const h = width * 1.55;
	const tipX = x1 - h * 1.05;
	const head = `<path d="M ${fmt(tipX)} ${fmt(y1)} L ${fmt(x1 + h * 0.2)} ${fmt(y1 - h)} L ${fmt(x1 + h * 0.2)} ${fmt(y1 + h)} Z" fill="${stroke}" stroke="${stroke}" stroke-width="${fmt(width * 0.35)}" stroke-linejoin="round"/>`;
	return arc + head;
}

/** A "save to disk" arrow dropping into a tray, centred inside the ring. */
function saveGlyph(cx: number, cy: number, stroke: string): string {
	const w = 6.5;
	return [
		`<path d="M ${cx} ${cy - 17} V ${cy + 5}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`,
		`<path d="M ${cx - 10} ${cy - 5} L ${cx} ${cy + 5} L ${cx + 10} ${cy - 5}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
		`<path d="M ${cx - 14} ${cy + 9} V ${cy + 15} H ${cx + 14} V ${cy + 9}" stroke="${stroke}" stroke-width="${w * 0.75}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
	].join("");
}

function checkGlyph(cx: number, cy: number, stroke: string): string {
	return `<path d="M ${cx - 14} ${cy + 1} L ${cx - 4} ${cy + 11} L ${cx + 15} ${cy - 10}" stroke="${stroke}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
}

function dotsGlyph(cx: number, cy: number, fill: string): string {
	return [-13, 0, 13].map((dx) => `<circle cx="${cx + dx}" cy="${cy}" r="4.5" fill="${fill}"/>`).join("");
}

function background(glow?: string): string {
	const glowLayer = glow
		? `<radialGradient id="glow" cx="50%" cy="40%" r="55%"><stop offset="0%" stop-color="${glow}" stop-opacity="0.28"/><stop offset="100%" stop-color="${glow}" stop-opacity="0"/></radialGradient>`
		: "";
	return (
		`<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#232733"/><stop offset="100%" stop-color="#0e1015"/></linearGradient>${glowLayer}</defs>` +
		`<rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>` +
		(glow ? `<rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>` : "")
	);
}

function label(text: string, fill: string, size = 29, y = 129): string {
	return `<text x="${CX}" y="${y}" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="${size}" fill="${fill}">${text}</text>`;
}

/** "15 sec" or "5 min" with the number emphasised; up to 60 seconds is shown in seconds. */
function durationLabel(duration: number, numberFill: string, unitFill: string): string {
	const [value, unit] = duration > 60 ? [duration / 60, "min"] : [duration, "sec"];
	return (
		`<text x="${CX}" y="129" text-anchor="middle" font-family="${FONT}" font-weight="bold">` +
		`<tspan font-size="31" fill="${numberFill}">${value}</tspan>` +
		`<tspan font-size="23" fill="${unitFill}" dx="5">${unit}</tspan>` +
		`</text>`
	);
}

function svg(body: string, size = SIZE): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/** Key face for a "save last N seconds" action. */
export function saveKeySvg(duration: SaveDuration, variant: SaveVariant): string {
	const accent = DURATION_ACCENT[duration];
	switch (variant) {
		case "ready":
			return svg(
				background(accent) +
					replayRing(CX, RING_CY, RING_R, accent, 8) +
					saveGlyph(CX, RING_CY, WHITE) +
					durationLabel(duration, WHITE, "#c9cedb"),
			);
		case "inactive":
			return svg(
				background() +
					replayRing(CX, RING_CY, RING_R, MUTED, 8) +
					saveGlyph(CX, RING_CY, MUTED) +
					durationLabel(duration, MUTED_TEXT, MUTED),
			);
		case "offline":
			return svg(
				background() +
					replayRing(CX, RING_CY, RING_R, MUTED, 8, true) +
					saveGlyph(CX, RING_CY, MUTED) +
					durationLabel(duration, MUTED_TEXT, MUTED),
			);
		case "saving":
			return svg(background(accent) + replayRing(CX, RING_CY, RING_R, accent, 8) + dotsGlyph(CX, RING_CY, WHITE) + label("SAVING", accent, 23));
		case "saved":
			return svg(background(GREEN) + replayRing(CX, RING_CY, RING_R, GREEN, 8) + checkGlyph(CX, RING_CY, WHITE) + label("SAVED", GREEN, 25));
	}
}

function recordDot(fill: string, hollow = false): string {
	return hollow
		? `<circle cx="${CX}" cy="${RING_CY}" r="13" fill="none" stroke="${fill}" stroke-width="5"/>`
		: `<circle cx="${CX}" cy="${RING_CY}" r="15" fill="${fill}"/>`;
}

function pill(text: string, fill: string, textFill: string, size = 25): string {
	const width = text.length > 3 ? 112 : 76;
	return (
		`<rect x="${CX - width / 2}" y="104" width="${width}" height="32" rx="16" fill="${fill}"/>` +
		`<text x="${CX}" y="${104 + 16 + size * 0.36}" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="${size}" fill="${textFill}">${text}</text>`
	);
}

/** Key face for the replay buffer on/off toggle. */
export function toggleKeySvg(variant: ToggleVariant): string {
	switch (variant) {
		case "on":
			return svg(background(RED) + replayRing(CX, RING_CY, RING_R, WHITE, 8) + recordDot(RED) + pill("ON", RED, WHITE));
		case "off":
			return svg(background() + replayRing(CX, RING_CY, RING_R, MUTED_TEXT, 8) + recordDot(MUTED_TEXT, true) + pill("OFF", "#2c313d", MUTED_TEXT));
		case "starting":
			return svg(background(AMBER) + replayRing(CX, RING_CY, RING_R, AMBER, 8) + dotsGlyph(CX, RING_CY, WHITE) + label("STARTING", AMBER, 21));
		case "stopping":
			return svg(background(AMBER) + replayRing(CX, RING_CY, RING_R, AMBER, 8) + dotsGlyph(CX, RING_CY, WHITE) + label("STOPPING", AMBER, 21));
		case "offline":
			return svg(background() + replayRing(CX, RING_CY, RING_R, MUTED, 8, true) + recordDot(MUTED, true) + label("NO OBS", MUTED_TEXT, 23));
		case "unavailable":
			return svg(background() + replayRing(CX, RING_CY, RING_R, MUTED, 8, true) + recordDot(MUTED, true) + label("DISABLED", MUTED_TEXT, 21));
	}
}

/** Clockwise arc from 12 o'clock covering `fraction` of the ring. */
function progressArc(fraction: number, stroke: string): string {
	if (fraction <= 0) return "";
	const [x1, y1] = polar(CX, RING_CY, RING_R, -90);
	const [x2, y2] = polar(CX, RING_CY, RING_R, -90 + 360 * fraction);
	const largeArc = fraction > 0.5 ? 1 : 0;
	return `<path d="M ${fmt(x1)} ${fmt(y1)} A ${RING_R} ${RING_R} 0 ${largeArc} 1 ${fmt(x2)} ${fmt(y2)}" fill="none" stroke="${stroke}" stroke-width="8" stroke-linecap="round"/>`;
}


/** Two interlocking chain links. */
function linkGlyph(cx: number, cy: number, stroke: string): string {
	const link = (dx: number) =>
		`<rect x="${cx + dx - 13}" y="${cy - 7}" width="26" height="14" rx="7" fill="none" stroke="${stroke}" stroke-width="5.5"/>`;
	return `<g transform="rotate(-45 ${cx} ${cy})">${link(-8)}${link(8)}</g>`;
}

/** Key face shown on a save key while its clip is uploaded to chibisafe. */
export function uploadKeySvg(variant: UploadVariant): string {
	if (variant === "copied") {
		return svg(
			background(GREEN) +
				`<circle cx="${CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="${GREEN}" stroke-width="8"/>` +
				linkGlyph(CX, RING_CY, WHITE) +
				label("LINK COPIED", GREEN, 18),
		);
	}

	const ring = `<circle cx="${CX}" cy="${RING_CY}" r="${RING_R}" fill="none" stroke="#2c313d" stroke-width="8"/>` + progressArc(variant / 100, BLUE);
	const percent = `<text x="${CX}" y="${RING_CY + 8}" text-anchor="middle" font-family="${FONT}" font-weight="bold" font-size="22" fill="${WHITE}">${variant}%</text>`;
	return svg(background(BLUE) + ring + percent + label("UPLOADING", BLUE, 19));
}

/** Monochrome white icon for the Stream Deck action list (20×20 / 40×40). */
export function actionListSvg(kind: "toggle" | "save"): string {
	const inner =
		kind === "toggle"
			? `<circle cx="${CX}" cy="${CX}" r="20" fill="${WHITE}"/>`
			: `<path d="M ${CX} ${CX - 24} V ${CX + 8} M ${CX - 15} ${CX - 7} L ${CX} ${CX + 8} L ${CX + 15} ${CX - 7} M ${CX - 20} ${CX + 15} V ${CX + 23} H ${CX + 20} V ${CX + 15}" stroke="${WHITE}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
	return svg(replayRing(CX, CX, 56, WHITE, 13) + inner);
}

/** Monochrome white category icon (28×28 / 56×56). */
export function categorySvg(): string {
	return svg(replayRing(CX, CX, 56, WHITE, 14) + `<circle cx="${CX}" cy="${CX}" r="22" fill="${WHITE}"/>`);
}

/** Full-colour plugin icon shown in Stream Deck preferences (256×256 / 512×512). */
export function pluginIconSvg(): string {
	return svg(
		`<defs><linearGradient id="pbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#2a2f3d"/><stop offset="100%" stop-color="#0e1015"/></linearGradient>` +
			`<radialGradient id="pglow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${RED}" stop-opacity="0.35"/><stop offset="100%" stop-color="${RED}" stop-opacity="0"/></radialGradient></defs>` +
			`<rect width="${SIZE}" height="${SIZE}" rx="30" fill="url(#pbg)"/>` +
			`<rect width="${SIZE}" height="${SIZE}" rx="30" fill="url(#pglow)"/>` +
			replayRing(CX, CX, 44, WHITE, 11) +
			`<circle cx="${CX}" cy="${CX}" r="20" fill="${RED}"/>`,
	);
}
