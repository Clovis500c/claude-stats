// Merges the usage of several computers, fully offline. Each computer writes a
// compact snapshot of its own events into a folder you already sync between
// them (OneDrive, Syncthing, a NAS, a USB key…), and the card is rendered from
// the union of every snapshot. No server, no network, no account.
// A computer only ever writes its own file, so the sync tool never has a
// conflict to resolve. The other computers don't need to be on: their last
// snapshot stays in the folder, and a copy is kept on this computer in case the
// folder is unreachable for a while.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { listTranscripts } from './collect.js';

const EXT = '.claude-stats.json.gz';
const VERSION = 1;
const LOCK_STALE_MS = 120e3;

// File-name safe name of this computer; --machine overrides the hostname.
export function machineName(override) {
  return (override || os.hostname()).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pc';
}

const snapshotPath = (dir, machine) => path.join(dir, machine + EXT);

// Write to a temp name then rename: a sync tool never picks up a half-written file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Events only hold counts and token totals, never any text.
export function serialize({ prompts, responses, tools, messages, lines }) {
  return zlib.gzipSync(JSON.stringify({ version: VERSION, events: { prompts, responses, tools, messages, lines } }));
}

export function deserialize(buf) {
  const data = JSON.parse(zlib.gunzipSync(buf));
  if (data.version !== VERSION) throw new Error(`unsupported snapshot version ${data.version}`);
  const revive = (list) => list.map((e) => ({ ...e, ts: new Date(e.ts) }));
  const { prompts, responses, tools, messages, lines } = data.events;
  return { prompts: revive(prompts), responses: revive(responses), tools: revive(tools), messages: revive(messages), lines: revive(lines) };
}

export function writeSnapshot(dir, machine, events) {
  const file = snapshotPath(dir, machine);
  writeAtomic(file, serialize(events));
  return file;
}

// True when a transcript changed since this computer's snapshot was written.
export function isStale(dir, machine, projectsDir) {
  let saved;
  try { saved = fs.statSync(snapshotPath(dir, machine)).mtimeMs; } catch { return true; }
  return listTranscripts(projectsDir).some((f) => fs.statSync(f).mtimeMs > saved);
}

// ---- the other computers -----------------------------------------------------

const peerPath = (peersDir, machine) => path.join(peersDir, machine + EXT);

function remember(peersDir, machine, buf) {
  if (!peersDir) return;
  const file = peerPath(peersDir, machine);
  try { if (fs.readFileSync(file).equals(buf)) return; } catch { /* not cached yet */ }
  writeAtomic(file, buf);
}

function cachedMachines(peersDir) {
  try { return fs.readdirSync(peersDir).filter((f) => f.endsWith(EXT)).map((f) => f.slice(0, -EXT.length)); } catch { return []; }
}

// Snapshots of the other computers. When the folder or a file can't be read for
// now (offline OneDrive placeholder, unplugged drive, half-synced file), the last
// good copy kept in `peersDir` is used instead of dropping that computer from
// the card. A computer whose file was removed from a readable folder is forgotten.
export function readSnapshots(dir, except, peersDir) {
  const found = [], skipped = [], listed = [];
  let reachable = true;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { reachable = false; }
  for (const f of names) {
    if (!f.endsWith(EXT)) continue;
    const machine = f.slice(0, -EXT.length);
    if (machine === except) continue;
    listed.push(machine);
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      found.push({ machine, events: deserialize(buf) });
      remember(peersDir, machine, buf);
    } catch { /* falls back to the cached copy below */ }
  }
  const read = new Set(found.map((f) => f.machine));
  for (const machine of reachable ? listed : cachedMachines(peersDir)) {
    if (read.has(machine) || machine === except) continue;
    try {
      found.push({ machine, cached: true, events: deserialize(fs.readFileSync(peerPath(peersDir, machine))) });
    } catch { skipped.push(machine); }
  }
  if (reachable && peersDir) {
    for (const machine of cachedMachines(peersDir)) if (!listed.includes(machine)) fs.rmSync(peerPath(peersDir, machine), { force: true });
  }
  return { found, skipped };
}

// Prompts, responses and tool calls carry a global id, so an event present on
// two computers (a session copied over) counts once. Messages and lines are the
// raw app-style counts, which don't de-duplicate: they are simply added up.
export function mergeEvents(parts) {
  const uniq = (key) => {
    const seen = new Map();
    for (const p of parts) for (const e of p[key]) if (!seen.has(e.id ?? e)) seen.set(e.id ?? e, e);
    return [...seen.values()];
  };
  return {
    prompts: uniq('prompts'),
    responses: uniq('responses'),
    tools: uniq('tools'),
    messages: parts.flatMap((p) => p.messages),
    lines: parts.flatMap((p) => p.lines),
  };
}

const recap = (machine, events, self, cached = false) => ({
  machine,
  self,
  cached,
  prompts: events.prompts.length,
  messages: events.messages.length,
  sessions: new Set(events.messages.map((m) => m.session)).size,
});

// Publishes this computer's snapshot, then merges it with the others.
// An empty history never overwrites a snapshot (wrong CLAUDE_CONFIG_DIR, fresh install…).
// An unreachable folder is not fatal: `error` says why, and the card is built from what is known.
export function syncEvents(local, { dir, machine, peersDir }) {
  let error = null;
  if (local.prompts.length || local.responses.length) {
    try { writeSnapshot(dir, machine, local); } catch (e) { error = e.message; }
  }
  const { found, skipped } = readSnapshots(dir, machine, peersDir);
  return {
    events: mergeEvents([local, ...found.map((f) => f.events)]),
    machines: [recap(machine, local, true), ...found.map((f) => recap(f.machine, f.events, false, f.cached))],
    skipped,
    error,
  };
}

// ---- one sync at a time -------------------------------------------------------

// Runs fn under a lock file. A run requested while another is going is
// remembered and done once more when the current one ends, so the last
// change is never missed. A lock left by a crashed run expires.
export function exclusive(lockFile, fn, retry = true) {
  const again = lockFile + '.again';
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { /* released meanwhile */ }
    if (age < LOCK_STALE_MS) { fs.writeFileSync(again, ''); return false; }
    fs.rmSync(lockFile, { force: true });
    return retry ? exclusive(lockFile, fn, false) : false;
  }
  try {
    do {
      fs.rmSync(again, { force: true });
      fn();
    } while (fs.existsSync(again));
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
  return true;
}
