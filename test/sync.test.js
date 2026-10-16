import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvents, aggregate } from '../src/collect.js';
import { machineName, serialize, deserialize, mergeEvents, syncEvents, writeSnapshot, readSnapshots, isStale, exclusive } from '../src/sync.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sync-'));

const usage = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, service_tier: 'standard' };

// A projects folder holding one session: `prompts` typed prompts, each answered once.
function computer(session, prompts) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'proj'));
  const lines = [];
  for (let i = 0; i < prompts; i++) {
    const timestamp = `2026-03-1${i}T10:00:00Z`;
    lines.push({ type: 'user', uuid: `${session}-u${i}`, sessionId: session, timestamp, message: { content: 'hello' } });
    lines.push({ type: 'assistant', uuid: `${session}-a${i}`, sessionId: session, timestamp, message: { id: `${session}-m${i}`, model: 'claude-opus-4-5', usage, content: [{ type: 'tool_use', id: `${session}-t${i}`, name: 'Bash' }] } });
  }
  fs.writeFileSync(path.join(dir, 'proj', `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  return dir;
}

test('machine names are safe file names', () => {
  assert.equal(machineName('DESKTOP-ABC 12'), 'desktop-abc-12');
  assert.equal(machineName('  '), 'pc');
});

test('a snapshot round-trips events and keeps only token counts', () => {
  const events = loadEvents(computer('a', 2));
  const back = deserialize(serialize(events));
  assert.ok(back.prompts[0].ts instanceof Date);
  assert.equal(back.prompts.length, 2);
  assert.deepEqual(aggregate(back).tokens, aggregate(events).tokens);
  assert.equal('service_tier' in back.lines[0].usage, false);
  assert.equal(JSON.stringify(back).includes('hello'), false); // no prompt text
});

test('two computers are added up', () => {
  const dir = tmp();
  const a = loadEvents(computer('a', 2));
  const b = loadEvents(computer('b', 3));
  syncEvents(b, { dir, machine: 'laptop' }); // the laptop publishes
  const { events, machines } = syncEvents(a, { dir, machine: 'desktop' });
  const stats = aggregate(events);
  assert.equal(stats.prompts, 5);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.messages, 10);
  assert.equal(stats.tokens.output, 500);
  assert.equal(stats.toolCalls, 5);
  assert.deepEqual(machines.map((m) => [m.machine, m.self, m.prompts]), [['desktop', true, 2], ['laptop', false, 3]]);
});

test('both computers end up with the same totals', () => {
  const dir = tmp();
  const a = loadEvents(computer('a', 2));
  const b = loadEvents(computer('b', 3));
  syncEvents(a, { dir, machine: 'desktop' });
  const fromLaptop = syncEvents(b, { dir, machine: 'laptop' });
  const fromDesktop = syncEvents(a, { dir, machine: 'desktop' });
  assert.deepEqual(aggregate(fromLaptop.events), aggregate(fromDesktop.events));
});

test('an event present on both computers counts once', () => {
  const a = loadEvents(computer('a', 2));
  const copy = loadEvents(computer('a', 2)); // the same session, copied over
  const merged = mergeEvents([a, copy]);
  assert.equal(merged.prompts.length, 2);
  assert.equal(merged.responses.length, 2);
  assert.equal(merged.tools.length, 2);
});

test('running again does not add this computer twice', () => {
  const dir = tmp();
  const a = loadEvents(computer('a', 2));
  syncEvents(a, { dir, machine: 'desktop' });
  assert.equal(aggregate(syncEvents(a, { dir, machine: 'desktop' }).events).prompts, 2);
});

test('an empty history never overwrites a snapshot', () => {
  const dir = tmp();
  syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop' });
  syncEvents(loadEvents(path.join(dir, 'nothing-here')), { dir, machine: 'desktop' });
  assert.equal(readSnapshots(dir, 'other').found[0].events.prompts.length, 2);
});

test('an unreadable snapshot is skipped, not fatal', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'laptop.claude-stats.json.gz'), 'half a file');
  fs.writeFileSync(path.join(dir, 'desktop.claude-stats.json.gz.123.tmp'), 'ignored');
  const { events, skipped } = syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop' });
  assert.deepEqual(skipped, ['laptop']);
  assert.equal(aggregate(events).prompts, 2);
});

test('the snapshot is stale once a transcript changes', () => {
  const dir = tmp();
  const projects = computer('a', 1);
  assert.equal(isStale(dir, 'desktop', projects), true); // never written
  writeSnapshot(dir, 'desktop', loadEvents(projects));
  assert.equal(isStale(dir, 'desktop', projects), false);
  const file = path.join(projects, 'proj', 'a.jsonl');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(isStale(dir, 'desktop', projects), true);
});

test('a computer that is switched off keeps counting: its last snapshot stays in the folder', () => {
  const dir = tmp();
  syncEvents(loadEvents(computer('b', 3)), { dir, machine: 'laptop' }); // the laptop saved, then was switched off
  const { events } = syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop' });
  assert.equal(aggregate(events).prompts, 5);
});

test('an unreadable snapshot falls back to the last good copy instead of dropping the computer', () => {
  const dir = tmp(), peersDir = tmp();
  syncEvents(loadEvents(computer('b', 3)), { dir, machine: 'laptop', peersDir });
  const a = loadEvents(computer('a', 2));
  assert.equal(aggregate(syncEvents(a, { dir, machine: 'desktop', peersDir }).events).prompts, 5); // copy taken
  fs.writeFileSync(path.join(dir, 'laptop.claude-stats.json.gz'), 'offline placeholder');
  const r = syncEvents(a, { dir, machine: 'desktop', peersDir });
  assert.equal(aggregate(r.events).prompts, 5);
  assert.equal(r.machines.find((m) => m.machine === 'laptop').cached, true);
  assert.deepEqual(r.skipped, []);
});

test('an unreachable folder falls back to the copies and reports why', () => {
  const dir = tmp(), peersDir = tmp();
  syncEvents(loadEvents(computer('b', 3)), { dir, machine: 'laptop', peersDir });
  syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop', peersDir }); // copy of the laptop taken
  const blocker = path.join(tmp(), 'file'); // a file where the folder should be
  fs.writeFileSync(blocker, '');
  const r = syncEvents(loadEvents(computer('a', 2)), { dir: path.join(blocker, 'sync'), machine: 'desktop', peersDir });
  assert.ok(r.error); // the snapshot could not be saved…
  assert.equal(aggregate(r.events).prompts, 5); // …but the laptop is still counted, from its copy
  assert.equal(r.machines.find((m) => m.machine === 'laptop').cached, true);
});

test('a computer removed from a readable folder is forgotten', () => {
  const dir = tmp(), peersDir = tmp();
  syncEvents(loadEvents(computer('b', 3)), { dir, machine: 'laptop', peersDir });
  syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop', peersDir });
  fs.rmSync(path.join(dir, 'laptop.claude-stats.json.gz'));
  const r = syncEvents(loadEvents(computer('a', 2)), { dir, machine: 'desktop', peersDir });
  assert.equal(aggregate(r.events).prompts, 2);
  assert.deepEqual(fs.readdirSync(peersDir), []);
});

test('only one sync runs at a time, and a request made meanwhile runs once more', () => {
  const lock = path.join(tmp(), 'sync.lock');
  let runs = 0;
  exclusive(lock, () => {
    runs++;
    if (runs === 1) assert.equal(exclusive(lock, () => assert.fail('must not run inside'), true), false); // asks for a rerun
  });
  assert.equal(runs, 2);
  assert.equal(fs.existsSync(lock), false);
});

test('a lock left by a crashed run expires', () => {
  const lock = path.join(tmp(), 'sync.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 10 * 60e3);
  fs.utimesSync(lock, old, old);
  let ran = false;
  assert.equal(exclusive(lock, () => { ran = true; }), true);
  assert.equal(ran, true);
});
