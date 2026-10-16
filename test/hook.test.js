import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks, hookCommand } from '../src/hook.js';

const settings = (obj) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hook-')), 'settings.json');
  if (obj) fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const cmd = hookCommand({ dir: String.raw`C:\Users\me\OneDrive\claude stats`, machine: 'desktop' });
const theirs = { type: 'command', command: 'claude-presence hook', async: true };

test('the command uses forward slashes and quotes the folder', () => {
  assert.equal(cmd, 'claude-stats sync --background --sync-dir "C:/Users/me/OneDrive/claude stats" --machine "desktop"');
});

test('installs Stop and SessionEnd hooks next to the existing ones, with a backup', () => {
  const file = settings({ theme: 'dark', hooks: { Stop: [{ hooks: [theirs] }] } });
  installHooks(cmd, file);
  const s = read(file);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.hooks.Stop[0].hooks, [theirs]);
  assert.equal(s.hooks.Stop[1].hooks[0].command, cmd);
  assert.equal(s.hooks.Stop[1].hooks[0].async, true);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, cmd);
  assert.equal(read(`${file}.bak-claude-stats`).theme, 'dark');
});

test('installing twice updates instead of duplicating', () => {
  const file = settings({});
  installHooks(cmd, file);
  installHooks(cmd.replace('desktop', 'laptop'), file);
  const s = read(file);
  assert.equal(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /laptop/);
});

test('works when settings.json does not exist yet', () => {
  const file = settings();
  installHooks(cmd, file);
  assert.equal(read(file).hooks.SessionEnd.length, 1);
});

test('uninstall removes only our hooks', () => {
  const file = settings({ hooks: { Stop: [{ hooks: [theirs] }], PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] } });
  installHooks(cmd, file);
  assert.equal(uninstallHooks(file), 2);
  assert.deepEqual(read(file), { hooks: { Stop: [{ hooks: [theirs] }], PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] } });
  assert.equal(uninstallHooks(file), 0);
});

test('uninstall drops the hooks key when nothing else is left', () => {
  const file = settings({ theme: 'dark' });
  installHooks(cmd, file);
  uninstallHooks(file);
  assert.deepEqual(read(file), { theme: 'dark' });
});

test('an invalid settings.json is never overwritten', () => {
  const file = settings();
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installHooks(cmd, file), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});
