#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEvents, aggregate, dailyCounts, claudeDir, readCache, writeCache } from '../src/collect.js';
import { syncEvents, isStale, machineName, exclusive } from '../src/sync.js';
import { installHooks, uninstallHooks, hookCommand, onPath, settingsFile } from '../src/hook.js';
import { renderCard, PALETTES, SECTIONS, TILES, DEFAULT_TILES, parseColor, prettyModel, compact } from '../src/render.js';
import { getToken, currentUser, putFile } from '../src/github.js';
import { totalCost, COST_PERIODS } from '../src/pricing.js';
import { schedule, unschedule, isDue, markPushed, FREQUENCIES } from '../src/schedule.js';

const HELP = `claude-stats — your Claude Code usage card, for your GitHub README

Usage
  claude-stats setup               guided setup: publish to your profile + automatic refresh
  claude-stats [generate]          write the SVG(s) locally
  claude-stats push                render and upload to GitHub
  claude-stats schedule --every X  refresh automatically (1h, 6h, 12h, 1d, 7d)
  claude-stats unschedule          stop the automatic refresh
  claude-stats sync                publish this computer's usage to --sync-dir and show every computer's totals
                                   (--background: do it detached and silently, for hooks)
  claude-stats hook install        save to --sync-dir after every Claude Code response (Stop and SessionEnd hooks)
  claude-stats hook uninstall      remove those hooks

Options
  --repo <owner/name>      target repo (default: <you>/<you>, your profile repo)
  --theme dark|light|auto  card theme (default: dark; auto follows the visitor's GitHub theme)
  --lang en|fr             card language (default: en)
  --range all|30d|7d       period for the numbers (default: all)
  --name <user>            name shown on the card (default: repo owner)
  --sync-dir <path>        add up several computers: a folder you sync between them (OneDrive, Syncthing…)
                           also read from $CLAUDE_STATS_SYNC_DIR
  --machine <name>         this computer's name in --sync-dir (default: hostname)

Look
  --title <text>           card title (default: "Claude Code usage")
  --palette <name>         heatmap colors: ${Object.keys(PALETTES).join(', ')} (default: blue)
  --accent <hex>           accent color for the badge and bars (default: #d97757)
  --weeks <n>              weeks shown in the heatmap, 8-52 (default: 26)
  --tiles <list>           stat tiles to show, in order (default: ${DEFAULT_TILES.join(',')})
                           available: ${TILES.join(', ')}
  --hide <list>            sections to leave out: ${SECTIONS.join(', ')}
  --hide-tools             same as --hide tools
  --transparent            no card background
  --cost                   add a banner with what your usage would cost at API prices (off by default)
  --cost-period 30d|5m|1y  window of that banner: last 30 days, 5 months or 12 months (default: 30d)
  --dir <path>             folder inside the repo (default: claude-stats)
  --branch <name>          target branch (default: repo default)
  --out <dir>              local output folder for generate (default: .)
  --every <freq>           with push: skip the upload if the last one is more recent than <freq>
  -v, --version            print the version
  -h, --help               print this help
`;

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string', default: 'dark' },
    lang: { type: 'string', default: 'en' },
    range: { type: 'string', default: 'all' },
    name: { type: 'string' },
    out: { type: 'string', default: '.' },
    repo: { type: 'string' },
    dir: { type: 'string', default: 'claude-stats' },
    branch: { type: 'string' },
    every: { type: 'string' },
    'sync-dir': { type: 'string' },
    machine: { type: 'string' },
    background: { type: 'boolean', default: false },
    'hide-tools': { type: 'boolean', default: false },
    title: { type: 'string' },
    palette: { type: 'string', default: 'blue' },
    accent: { type: 'string' },
    weeks: { type: 'string', default: '26' },
    tiles: { type: 'string' },
    hide: { type: 'string' },
    transparent: { type: 'boolean', default: false },
    cost: { type: 'boolean', default: false },
    'cost-period': { type: 'string', default: '30d' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

// Absolute, because the scheduled job runs from another working directory.
const syncDir = opt['sync-dir'] || process.env.CLAUDE_STATS_SYNC_DIR;
opt['sync-dir'] = syncDir ? path.resolve(syncDir) : undefined;
opt.machine = machineName(opt.machine);
// Bookkeeping files live next to the other state file, on this computer only.
const home = (name) => path.join(os.homedir(), name);
const CACHE = home('.claude-stats-cache.json.gz'); // parsed transcripts: only changed files are read again
const LOCK = home('.claude-stats-sync.lock');
const LOG = home('.claude-stats-sync.log');
const syncOpts = () => ({ dir: opt['sync-dir'], machine: opt.machine, peersDir: home('.claude-stats-peers') });

// This computer's events; unchanged transcripts come from the cache, so a re-run takes a fraction of a second.
function localEvents() {
  const dir = path.join(claudeDir(), 'projects');
  const cache = readCache(CACHE, dir);
  const stats = {};
  const events = loadEvents(dir, cache, stats);
  if (stats.changed) try { writeCache(CACHE, dir, cache); } catch { /* only an optimization */ }
  return events;
}

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

// Validates look options up front so a typo fails loudly instead of silently.
function lookOptions() {
  const oneOf = (name, allowed) => {
    if (!allowed.includes(opt[name])) throw new Error(`Invalid --${name} "${opt[name]}". Use one of: ${allowed.join(', ')}`);
  };
  oneOf('theme', ['dark', 'light', 'auto']);
  oneOf('lang', ['en', 'fr']);
  oneOf('range', ['all', '30d', '7d']);
  oneOf('cost-period', Object.keys(COST_PERIODS));
  if (opt.repo && !/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) throw new Error(`Invalid --repo "${opt.repo}". Use the form owner/name`);
  if (!PALETTES[opt.palette]) throw new Error(`Unknown palette "${opt.palette}". Use one of: ${Object.keys(PALETTES).join(', ')}`);
  if (opt.accent && !parseColor(opt.accent)) throw new Error(`Invalid --accent "${opt.accent}". Use a hex color like #d97757`);
  const weeks = Number(opt.weeks);
  if (!Number.isInteger(weeks) || weeks < 8 || weeks > 52) throw new Error('--weeks must be a whole number from 8 to 52');
  const hide = list(opt.hide);
  if (opt['hide-tools']) hide.push('tools');
  const badHide = hide.filter((h) => !SECTIONS.includes(h));
  if (badHide.length) throw new Error(`Unknown section(s) in --hide: ${badHide.join(', ')}. Available: ${SECTIONS.join(', ')}`);
  const tiles = opt.tiles ? list(opt.tiles) : DEFAULT_TILES;
  const badTiles = tiles.filter((k) => !TILES.includes(k));
  if (badTiles.length) throw new Error(`Unknown tile(s) in --tiles: ${badTiles.join(', ')}. Available: ${TILES.join(', ')}`);
  return { title: opt.title, palette: opt.palette, accent: opt.accent, weeks, hide, tiles, transparent: opt.transparent };
}

// One line per computer when several are added up.
const machinesRecap = ({ machines, skipped, error }) =>
  machines.map((m) => `  ${m.machine}${m.self ? ' (this PC)' : ''}${m.cached ? ' (last known copy)' : ''}: ${m.sessions.toLocaleString('en-US')} sessions, ${m.messages.toLocaleString('en-US')} messages, ${m.prompts.toLocaleString('en-US')} prompts`)
    .concat(skipped.map((m) => `  ${m}: snapshot not readable yet (still syncing?), ignored this time`))
    .concat(error ? [`  ! could not save this PC's snapshot: ${error}`] : [])
    .join('\n');

function build() {
  const look = lookOptions();
  const local = localEvents();
  const synced = opt['sync-dir'] ? syncEvents(local, syncOpts()) : null;
  const events = synced ? synced.events : local;
  if (!events.prompts.length && !events.responses.length) throw new Error('No Claude Code transcripts found in ~/.claude/projects.');
  if (synced) console.log(`Added up ${synced.machines.length} computer(s) from ${opt['sync-dir']}:\n${machinesRecap(synced)}`);
  const stats = aggregate(events, opt.range);
  const counts = dailyCounts(events);
  const cost = totalCost(events, { period: opt['cost-period'] });
  const card = (theme) => renderCard(stats, counts, { ...look, lang: opt.lang, theme, name: opt.name, cost: opt.cost ? cost : null });
  // auto = dark + light files, picked by the visitor's theme in the README
  const files = opt.theme === 'auto'
    ? { 'claude-stats.svg': card('dark'), 'claude-stats-light.svg': card('light') }
    : { 'claude-stats.svg': card(opt.theme === 'light' ? 'light' : 'dark') };
  return { stats, cost, files };
}

function snippet(repo, dir, branch = 'HEAD') {
  const base = `https://raw.githubusercontent.com/${repo}/${branch}/${dir}`;
  if (opt.theme !== 'auto') return `<img alt="Claude Code usage" src="${base}/claude-stats.svg" />`;
  return `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${base}/claude-stats.svg" />
  <source media="(prefers-color-scheme: light)" srcset="${base}/claude-stats-light.svg" />
  <img alt="Claude Code usage" src="${base}/claude-stats.svg" />
</picture>`;
}

async function resolveRepo(token) {
  if (!opt.repo) {
    const login = await currentUser(token);
    opt.repo = `${login}/${login}`;
  }
  opt.name ??= opt.repo.split('/')[0];
  return opt.repo;
}

async function push() {
  // Scheduled runs pass --every; bail out before any work if it's not time yet.
  if (opt.repo && opt.every && !isDue(opt.repo, opt.every)) {
    // The card isn't due, but the other computers read this one's snapshot: keep it fresh.
    if (opt['sync-dir'] && isStale(opt['sync-dir'], opt.machine, path.join(claudeDir(), 'projects'))) syncEvents(localEvents(), syncOpts());
    return console.log('Not due yet, skipping.');
  }
  const token = getToken();
  const repo = await resolveRepo(token);
  const { files } = build();
  let changed = 0;
  for (const [name, svg] of Object.entries(files)) {
    const p = path.posix.join(opt.dir, name);
    if (await putFile(token, repo, p, svg, { branch: opt.branch, message: `chore(claude-stats): update ${name}` })) changed++;
  }
  markPushed(repo);
  console.log(changed ? `✔ Updated ${changed} file(s) in ${repo}` : `✔ ${repo} already up to date`);
}

// Arguments the scheduled job re-runs push with.
const jobArgs = () => {
  const a = ['push', '--repo', opt.repo, '--theme', opt.theme, '--lang', opt.lang, '--range', opt.range, '--dir', opt.dir, '--name', opt.name];
  // Forward every option the user set, so the scheduled card looks the same.
  for (const k of ['branch', 'title', 'palette', 'accent', 'weeks', 'tiles', 'hide', 'cost-period', 'sync-dir', 'machine']) if (opt[k] != null) a.push(`--${k}`, String(opt[k]));
  for (const k of ['hide-tools', 'transparent', 'cost']) if (opt[k]) a.push(`--${k}`);
  return a;
};

const MENU = [
  ['1h', 'Every hour'],
  ['6h', 'Every 6 hours'],
  ['12h', 'Every 12 hours'],
  ['1d', 'Once a day (recommended)'],
  ['7d', 'Once a week'],
  ['off', 'Never, I\'ll run "claude-stats push" myself'],
];

async function setup() {
  const token = getToken();
  const login = await currentUser(token);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, d) => (await rl.question(`${q} (${d}) `)).trim() || d;

  opt.repo = await ask('Repo to publish to?', opt.repo || `${login}/${login}`);
  const sync = await ask('Add up several computers? Folder synced between them (OneDrive, Syncthing…), or none', opt['sync-dir'] || 'none');
  opt['sync-dir'] = sync === 'none' ? undefined : path.resolve(sync);
  const wantHook = opt['sync-dir'] && (await ask('Save to that folder after every Claude Code response, so a PC switched off is never behind? y/n', 'y')).toLowerCase().startsWith('y');
  opt.lang = await ask('Language en/fr?', opt.lang);
  opt.theme = await ask('Theme dark/light/auto?', opt.theme);
  if ((await ask('Customize colors and sections? y/n', 'n')).toLowerCase().startsWith('y')) {
    opt.palette = await ask(`Heatmap palette (${Object.keys(PALETTES).join('/')})?`, opt.palette);
    opt.accent = await ask('Accent color (hex)?', opt.accent || '#d97757');
    opt.title = await ask('Card title?', opt.title || 'Claude Code usage');
    const hide = await ask(`Sections to hide, comma-separated (${SECTIONS.join(', ')})?`, opt.hide || 'none');
    opt.hide = hide === 'none' ? undefined : hide;
    opt.cost = (await ask('Show what your usage would cost at API prices? y/n', opt.cost ? 'y' : 'n')).toLowerCase().startsWith('y');
    if (opt.cost) opt['cost-period'] = await ask('Over the last 30d, 5m (5 months) or 1y (12 months)?', opt['cost-period']);
  }
  lookOptions(); // fail before publishing if an answer is invalid

  let every = opt.every;
  if (!every) {
    console.log('\nHow often should the card update?');
    MENU.forEach(([, label], i) => console.log(`  ${i + 1}) ${label}`));
    for (;;) {
      const a = await ask('Choice', '4');
      every = MENU[Number(a) - 1]?.[0] ?? (FREQUENCIES[a] || a === 'off' ? a : null);
      if (every) break;
      console.log('  Please type a number from 1 to 6.');
    }
  }
  rl.close();

  opt.every = undefined; // the first push always happens
  await push();
  if (every === 'off') {
    unschedule();
    console.log('✔ No automatic refresh. Run "claude-stats push" whenever you want to update the card.');
  } else {
    console.log(`✔ Scheduled: ${schedule(jobArgs(), every)}`);
    console.log('  If the computer is off at that time, it updates within an hour of being back on.');
  }
  if (wantHook) installSyncHooks();
  console.log(`\nAdd this to your README.md:\n\n${snippet(opt.repo, opt.dir, opt.branch)}\n`);
}

// Publishes this computer's snapshot now and shows every computer's totals.
function syncNow() {
  let synced;
  const ran = exclusive(LOCK, () => { synced = syncEvents(localEvents(), syncOpts()); });
  if (!ran) return console.log('Another sync is running; it will run once more when it ends.');
  if (process.env.CLAUDE_STATS_BACKGROUND) {
    // The log only exists while the last detached run failed.
    if (synced.error) fs.writeFileSync(LOG, `${new Date().toISOString()} ${synced.error}\n`);
    else fs.rmSync(LOG, { force: true });
  }
  console.log(`${synced.error ? '✖ Snapshot NOT written' : '✔ Snapshot written'} (${opt.machine} → ${opt['sync-dir']})\n${machinesRecap(synced)}`);
  if (synced.error) process.exitCode = 1;
}

function installSyncHooks() {
  if (!opt['sync-dir']) throw new Error('--sync-dir is required (or set CLAUDE_STATS_SYNC_DIR)');
  if (!onPath()) throw new Error('The hooks run "claude-stats": install it globally first (see Quick start), then retry.');
  installHooks(hookCommand({ dir: opt['sync-dir'], machine: opt.machine }));
  console.log(`✔ Hooks installed in ${settingsFile()}: ${opt.machine} is saved to ${opt['sync-dir']} after every Claude Code response.`);
  syncNow();
}

// Short human-readable recap printed after a local render.
function summary(stats, cost) {
  const n = (x) => x.toLocaleString('en-US');
  const rows = [
    ['Sessions', n(stats.sessions)],
    ['Messages', n(stats.messages)],
    ['Prompts', n(stats.prompts)],
    ['Active days', `${n(stats.activeDays)} (longest streak: ${stats.longestStreak})`],
    ['Tokens generated', compact(stats.tokens.output)],
    ['Tokens processed', compact(stats.tokensTotal)],
    ['Tool calls', n(stats.toolCalls)],
    ['Favorite model', prettyModel(stats.favoriteModel)],
    [`Cost, last ${cost.period}`, `$${cost.usd.toFixed(2)} at API prices${cost.unpriced ? ` (${cost.unpriced} responses from unknown models not counted)` : ''}`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join('\n');
}

function version() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

async function main() {
  const cmd = positionals[0] || 'generate';
  if (opt.version || cmd === 'version') return console.log(version());
  if (opt.help || cmd === 'help') return console.log(HELP);
  switch (cmd) {
    case 'generate': {
      const { stats, cost, files } = build();
      fs.mkdirSync(opt.out, { recursive: true });
      for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(opt.out, name), svg);
      console.log(`✔ Wrote ${Object.keys(files).join(', ')} to ${path.resolve(opt.out)}`);
      console.log(summary(stats, cost));
      break;
    }
    case 'push': await push(); break;
    case 'sync': {
      if (!opt['sync-dir']) throw new Error('--sync-dir is required (or set CLAUDE_STATS_SYNC_DIR)');
      if (!opt.background) return syncNow();
      // A hook must return at once and must not die with Claude Code: run detached.
      const args = process.argv.slice(2).filter((a) => a !== '--background');
      spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
        detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAUDE_STATS_BACKGROUND: '1' },
      }).unref();
      break;
    }
    case 'hook': {
      if (positionals[1] === 'install') return installSyncHooks();
      if (positionals[1] !== 'uninstall') throw new Error('Usage: claude-stats hook install|uninstall');
      const n = uninstallHooks();
      console.log(n ? `✔ Removed ${n} hook(s) from ${settingsFile()}` : 'No claude-stats hook found');
      break;
    }
    case 'setup': await setup(); break;
    case 'schedule': {
      if (!opt.every) throw new Error(`--every is required: ${Object.keys(FREQUENCIES).join(', ')}`);
      await resolveRepo(getToken());
      console.log(`✔ Scheduled: ${schedule(jobArgs(), opt.every)}`);
      break;
    }
    case 'unschedule': console.log(unschedule() ? '✔ Automatic refresh stopped' : 'Nothing was scheduled'); break;
    default: console.log(HELP); process.exitCode = 1;
  }
}

main().catch((e) => {
  // A detached run has no terminal: keep the reason where `sync` can be debugged.
  if (process.env.CLAUDE_STATS_BACKGROUND) try { fs.writeFileSync(LOG, `${new Date().toISOString()} ${e.message}\n`); } catch { /* nowhere to report */ }
  else console.error(`✖ ${e.message}`);
  process.exitCode = 1;
});
