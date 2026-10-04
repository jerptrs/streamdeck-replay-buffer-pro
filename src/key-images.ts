import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The bundle lives in <plugin>.sdPlugin/bin, the pre-rendered key faces in <plugin>.sdPlugin/imgs/keys.
const keysDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "imgs", "keys");
const cache = new Map<string, string>();

/** A key face drawn at runtime (custom length keys), as a data URL for `setImage`. */
export function svgImage(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Loads a pre-rendered 144×144 key face (see scripts/render-icons.ts) as a data URL for `setImage`. */
export function keyImage(name: string): string {
	let image = cache.get(name);
	if (!image) {
		image = `data:image/png;base64,${readFileSync(path.join(keysDir, `${name}@2x.png`)).toString("base64")}`;
		cache.set(name, image);
	}
	return image;
}
