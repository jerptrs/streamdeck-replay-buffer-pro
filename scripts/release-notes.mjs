/**
 * Prints the CHANGELOG.md section for a version, for use as GitHub release notes. Relative links are
 * rewritten to point at the tagged files on GitHub, since release notes can't resolve them.
 *
 * Usage: node scripts/release-notes.mjs <version>    e.g. node scripts/release-notes.mjs 1.2.0
 * Exits with an error when the changelog has no entries for that version.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
	console.error("Usage: node scripts/release-notes.mjs <version>");
	process.exit(1);
}

const lines = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
// A section ends at the next version heading, or at the link definitions at the bottom of the file.
const length = lines.slice(start + 1).findIndex((line) => line.startsWith("## ") || /^\[[^\]]+\]: /.test(line));
const notes = start === -1 ? "" : lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join("\n").trim();

if (!notes) {
	console.error(`CHANGELOG.md has no entries for ${version}. Add a "## [${version}] - YYYY-MM-DD" section before tagging.`);
	process.exit(1);
}

const { repository } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1];
const base = `https://github.com/${repo}/blob/v${version}/`;

// [text](FILE.md) → [text](https://github.com/<repo>/blob/v<version>/FILE.md); full URLs and #anchors stay as they are.
console.log(notes.replace(/\]\((?![a-z]+:|#)([^)\s]+)\)/gi, (_, target) => `](${base}${target})`));
