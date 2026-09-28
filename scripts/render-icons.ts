/**
 * Rasterises the artwork in src/icons.ts into the PNG files referenced by the manifest and
 * loaded by the plugin at runtime. Run with `npm run icons` (Node 24+ runs .ts files natively).
 *
 * Pass `--preview <file.png>` to also write a contact sheet of every key face.
 */
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	actionListSvg,
	categorySvg,
	pluginIconSvg,
	SAVE_DURATIONS,
	SAVE_VARIANTS,
	saveKeyName,
	saveKeySvg,
	TOGGLE_VARIANTS,
	toggleKeyName,
	toggleKeySvg,
} from "../src/icons.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imgs = path.join(root, "com.replay-buffer-pro.obs.sdPlugin", "imgs");

// Arial Bold is what the artwork is designed around. Prefer the real font files (Windows, WSL or
// macOS) and fall back to whatever the system has.
const fontCandidates = [
	"C:\\Windows\\Fonts\\arialbd.ttf",
	"/mnt/c/Windows/Fonts/arialbd.ttf",
	"/System/Library/Fonts/Supplemental/Arial Bold.ttf",
	"/Library/Fonts/Arial Bold.ttf",
];
const fontFiles = fontCandidates.filter((file) => existsSync(file));
if (fontFiles.length === 0) {
	console.warn("Arial Bold not found; falling back to system fonts, so key labels may look different.");
}

const fontOptions: ResvgRenderOptions["font"] = {
	fontFiles,
	loadSystemFonts: fontFiles.length === 0,
	defaultFontFamily: "Arial",
};

function render(svg: string, size: number): Buffer {
	return new Resvg(svg, { fitTo: { mode: "width", value: size }, font: fontOptions }).render().asPng();
}

/** Writes `<name>.png` at `size` and `<name>@2x.png` at double that. */
function writePair(dir: string, name: string, svg: string, size: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `${name}.png`), render(svg, size));
	writeFileSync(path.join(dir, `${name}@2x.png`), render(svg, size * 2));
}

const keyFaces: { name: string; svg: string }[] = [
	...TOGGLE_VARIANTS.map((variant) => ({ name: toggleKeyName(variant), svg: toggleKeySvg(variant) })),
	...SAVE_DURATIONS.flatMap((duration) =>
		SAVE_VARIANTS.map((variant) => ({ name: saveKeyName(duration, variant), svg: saveKeySvg(duration, variant) })),
	),
];

for (const { name, svg } of keyFaces) {
	writePair(path.join(imgs, "keys"), name, svg, 72);
}

writePair(path.join(imgs, "actions"), "toggle", actionListSvg("toggle"), 20);
writePair(path.join(imgs, "actions"), "save", actionListSvg("save"), 20);
writePair(path.join(imgs, "plugin"), "category-icon", categorySvg(), 28);
writePair(path.join(imgs, "plugin"), "marketplace", pluginIconSvg(), 256);

console.log(`Rendered ${keyFaces.length} key faces and 4 icons into ${path.relative(root, imgs)}`);

const previewIndex = process.argv.indexOf("--preview");
if (previewIndex !== -1 && process.argv[previewIndex + 1]) {
	const cell = 144;
	const gap = 16;
	const columns = SAVE_VARIANTS.length > TOGGLE_VARIANTS.length ? SAVE_VARIANTS.length : TOGGLE_VARIANTS.length;
	const rows = 1 + SAVE_DURATIONS.length;
	const width = columns * (cell + gap) + gap;
	const height = rows * (cell + gap) + gap;
	const toDataUrl = (svg: string) => `data:image/png;base64,${render(svg, cell).toString("base64")}`;

	const placed = [
		TOGGLE_VARIANTS.map((variant) => toggleKeySvg(variant)),
		...SAVE_DURATIONS.map((duration) => SAVE_VARIANTS.map((variant) => saveKeySvg(duration, variant))),
	].flatMap((row, r) =>
		row.map(
			(svg, c) =>
				`<g transform="translate(${gap + c * (cell + gap)} ${gap + r * (cell + gap)})">` +
				`<clipPath id="k${r}${c}"><rect width="${cell}" height="${cell}" rx="18"/></clipPath>` +
				`<image width="${cell}" height="${cell}" href="${toDataUrl(svg)}" clip-path="url(#k${r}${c})"/></g>`,
		),
	);

	const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/>${placed.join("")}</svg>`;
	const out = path.resolve(process.argv[previewIndex + 1]);
	writeFileSync(out, new Resvg(sheet, { font: fontOptions }).render().asPng());
	console.log(`Preview written to ${out}`);
}
