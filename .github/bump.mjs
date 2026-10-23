// Turns CHANGELOG's [Unreleased] section into a new version and bumps package.json.
// Minor when something was Added, patch otherwise. Prints the new version, or nothing
// when [Unreleased] is empty (nothing to release).
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2] || '.';
const log = readFileSync(`${dir}/CHANGELOG.md`, 'utf8');
const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));

const unreleased = /^## \[Unreleased\]\r?\n([\s\S]*?)(?=^## )/m.exec(log)?.[1] ?? '';
if (!unreleased.trim()) process.exit(0);

const old = pkg.version;
const [maj, min, pat] = old.split('.').map(Number);
const next = /^### Added/m.test(unreleased) ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
const date = new Date().toISOString().slice(0, 10);
const repo = 'https://github.com/Clovis500c/claude-stats';

const out = log
  .replace(/^## \[Unreleased\]\r?\n/m, `## [Unreleased]\n\n## [${next}] - ${date}\n`)
  .replace(`[Unreleased]: ${repo}/compare/v${old}...HEAD`,
    `[Unreleased]: ${repo}/compare/v${next}...HEAD\n[${next}]: ${repo}/compare/v${old}...v${next}`);
if (out === log) throw new Error('CHANGELOG format not recognised');

pkg.version = next;
writeFileSync(`${dir}/CHANGELOG.md`, out);
writeFileSync(`${dir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(next);
