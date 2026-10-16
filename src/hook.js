// Claude Code hooks that save this computer's usage to the sync folder after every
// response and when a session ends, so the other computers are never more than a
// few seconds behind, even if this one is switched off right afterwards.
// The entries are recognised by their command, so installing twice updates them
// and uninstalling removes only them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeDir } from './collect.js';

const EVENTS = ['Stop', 'SessionEnd'];
const isOurs = (h) => typeof h?.command === 'string' && /^claude-stats sync --background\b/.test(h.command);

export const settingsFile = () => path.join(claudeDir(), 'settings.json');

// Forward slashes work in every shell and in node; $ and ` are escaped for bash.
const quote = (s) => `"${s.replace(/\\/g, '/').replace(/(["$`])/g, '\\$1')}"`;

export function hookCommand({ dir, machine }) {
  return `claude-stats sync --background --sync-dir ${quote(dir)} --machine ${quote(machine)}`;
}

// The hook calls the installed `claude-stats`: refuse to install one that can't run.
export function onPath(cmd = 'claude-stats') {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function read(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON, left untouched.`); }
}

// Removes our entries (and the groups they leave empty). Returns how many.
function strip(settings) {
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const kept = [];
    let here = 0;
    for (const g of groups) {
      const ours = (g.hooks || []).filter(isOurs).length;
      here += ours;
      if (!ours) kept.push(g);
      else if (g.hooks.length > ours) kept.push({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) });
    }
    removed += here;
    if (kept.length) settings.hooks[event] = kept;
    else if (here) delete settings.hooks[event];
  }
  if (removed && settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

function write(file, settings) {
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

export function installHooks(command, file = settingsFile()) {
  const settings = read(file);
  // One backup of the user's settings, taken before the first change.
  const backup = `${file}.bak-claude-stats`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  strip(settings);
  settings.hooks ??= {};
  for (const event of EVENTS) {
    (settings.hooks[event] ??= []).push({ hooks: [{ type: 'command', command, timeout: 60, async: true }] });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(file, settings);
  return EVENTS;
}

export function uninstallHooks(file = settingsFile()) {
  if (!fs.existsSync(file)) return 0;
  const settings = read(file);
  const removed = strip(settings);
  if (removed) write(file, settings);
  return removed;
}
