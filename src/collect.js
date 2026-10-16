// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) and computes
// usage stats. Transcripts need de-duplication to give honest numbers:
//  - one API response is written as several lines (one per content block),
//    each repeating the same usage → count each response id once;
//  - resumed/forked sessions copy earlier lines into a new file → count each
//    line uuid once;
//  - most "user" lines are tool results or system notices, not prompts.
// The card's messages and tokens skip that de-duplication on purpose, to match
// the Claude app's stats: every user/assistant line is a message, and every
// line's usage is summed (subagent lines included). The cost stays de-duplicated.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function listTranscripts(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Text Claude Code injects as a "user" turn although nobody typed it.
const SYNTHETIC = /^(\[Request interrupted|This session is being continued|Caveat:|<(command-|local-command|task-notification|bash-))/;

function promptText(o) {
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b.type === 'tool_result')) return null;
  return c.find((b) => b.type === 'text')?.text ?? '';
}

// The four token counts the card reads, nothing else.
export const slimUsage = (u) => ({
  input_tokens: u.input_tokens || 0,
  output_tokens: u.output_tokens || 0,
  cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  cache_read_input_tokens: u.cache_read_input_tokens || 0,
});

// One file → compact records (timestamps in ms, no text). Kept per file so an
// unchanged transcript is never read again: see loadEvents' cache.
//   m message · l usage line · p prompt · r response line · t tool call
function parseTranscript(text) {
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.timestamp) continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts)) continue;

    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) recs.push({ k: 'm', ts, s: o.sessionId });
    if (o.type === 'assistant' && o.message?.usage) recs.push({ k: 'l', ts, model: o.message.model, usage: slimUsage(o.message.usage) });
    if (o.isSidechain && o.type !== 'assistant') continue; // subagent prompts are not the user's
    if (o.type === 'user' && !o.isMeta && o.uuid) {
      const t = promptText(o);
      if (t != null && !SYNTHETIC.test(t.trimStart())) recs.push({ k: 'p', id: o.uuid, ts, s: o.sessionId });
    } else if (o.type === 'assistant' && o.message?.id && o.message.usage) {
      for (const b of (o.isSidechain ? null : o.message.content) || []) {
        if (b.type === 'tool_use' && b.id) recs.push({ k: 't', id: b.id, ts, name: b.name });
      }
      const u = o.message.usage;
      recs.push({
        k: 'r', id: o.message.id, ts, s: o.sessionId, model: o.message.model, sc: !!o.isSidechain,
        speed: u.speed, ws: u.server_tool_use?.web_search_requests,
        u: {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
          w5: u.cache_creation?.ephemeral_5m_input_tokens,
          w1: u.cache_creation?.ephemeral_1h_input_tokens,
        },
      });
    }
  }
  return recs;
}

// Records of every file, in file order → the de-duplicated events.
function assemble(recs) {
  const prompts = new Map(); // uuid → prompt
  const responses = new Map(); // message id → response
  const tools = new Map(); // tool_use block id → call
  const messages = []; // every main-session user/assistant line
  const lines = []; // every assistant line's usage, subagents included
  for (const r of recs) {
    if (r.k === 'm') messages.push({ ts: new Date(r.ts), session: r.s });
    else if (r.k === 'l') lines.push({ ts: new Date(r.ts), model: r.model, usage: r.usage });
    else if (r.k === 'p') {
      if (!prompts.has(r.id)) prompts.set(r.id, { id: r.id, ts: new Date(r.ts), session: r.s });
    } else if (r.k === 't') {
      if (!tools.has(r.id)) tools.set(r.id, { id: r.id, ts: new Date(r.ts), name: r.name });
    } else if (r.k === 'r') {
      const prev = responses.get(r.id);
      // Streaming lines can carry partial counts; keep the largest of each.
      const max = (a, b) => (a == null && b == null ? undefined : Math.max(a || 0, b || 0));
      const pick = (k) => max(prev?.usage[k], r.u[k]) || 0;
      responses.set(r.id, {
        id: r.id,
        ts: prev?.ts ?? new Date(r.ts),
        session: r.s,
        model: r.model,
        sidechain: r.sc,
        speed: r.speed ?? prev?.speed,
        webSearches: max(prev?.webSearches, r.ws) || 0,
        usage: {
          input_tokens: pick('input_tokens'),
          output_tokens: pick('output_tokens'),
          cache_creation_input_tokens: pick('cache_creation_input_tokens'),
          cache_read_input_tokens: pick('cache_read_input_tokens'),
          // split of the cache writes by lifetime, when the transcript has it
          cache_write_5m: max(prev?.usage.cache_write_5m, r.u.w5),
          cache_write_1h: max(prev?.usage.cache_write_1h, r.u.w1),
        },
      });
    }
  }
  return { prompts: [...prompts.values()], responses: [...responses.values()], tools: [...tools.values()], messages, lines };
}

// Returns { prompts: [{id, ts, session}], responses: [{id, ts, session, model, usage, speed, webSearches, sidechain}], tools: [{id, ts, name}],
//           messages: [{ts, session}], lines: [{ts, model, usage}] }
// The ids (line uuid, response id, tool_use id) let several computers' events be merged without double counting.
// Subagent (sidechain) responses are kept for the cost estimate but left out of the stats.
// messages and lines are the raw, app-style counts (see top of file).
// `cache` ({ [file]: { mtimeMs, size, recs } }) is filled in as files are read and
// updated in place: a file whose mtime and size are unchanged is not parsed again.
// `stats.changed` counts the files parsed or dropped, so callers know when to save the cache.
export function loadEvents(dir = path.join(claudeDir(), 'projects'), cache = {}, stats = {}) {
  stats.changed = 0;
  const seen = new Set();
  const recs = [];
  for (const file of listTranscripts(dir)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let hit = cache[file];
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      hit = cache[file] = { mtimeMs: st.mtimeMs, size: st.size, recs: parseTranscript(text) };
      stats.changed++;
    }
    seen.add(file);
    for (const r of hit.recs) recs.push(r);
  }
  for (const file of Object.keys(cache)) {
    if (seen.has(file)) continue;
    delete cache[file];
    stats.changed++;
  }
  return assemble(recs);
}

// The parse cache lives on this computer only (never in the synced folder).
export function readCache(file, dir) {
  try {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
    return data.version === 1 && data.dir === dir ? data.files : {};
  } catch { return {}; }
}

export function writeCache(file, dir, files) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ version: 1, dir, files })));
  fs.renameSync(tmp, file);
}

const RANGES = { all: Infinity, '30d': 30, '7d': 7 };

// Longest run of consecutive calendar days found in a set of day keys.
function longestStreak(dayKeys) {
  const days = [...dayKeys].sort();
  let best = 0, run = 0, prev = null;
  for (const k of days) {
    const d = new Date(`${k}T12:00:00`);
    run = prev && Math.round((d - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

const toolName = (n) => (n?.startsWith('mcp__') ? n.split('__').slice(2).join('__') || n : n);

// messages and lines default to prompts and responses for callers that only have those.
export function aggregate({ prompts, responses, tools = [], messages = prompts, lines = responses }, range = 'all') {
  const days = RANGES[range] ?? Infinity;
  const since = days === Infinity ? 0 : Date.now() - days * 86400000;
  const P = prompts.filter((e) => e.ts.getTime() >= since);
  const R = responses.filter((e) => !e.sidechain && e.ts.getTime() >= since);
  const T = tools.filter((e) => e.ts.getTime() >= since);
  const M = messages.filter((e) => e.ts.getTime() >= since);
  const L = lines.filter((e) => e.ts.getTime() >= since);

  const sessions = new Set();
  const activeDays = new Set();
  for (const e of P) {
    sessions.add(e.session);
    activeDays.add(dayKey(e.ts));
  }
  // Peak hour like the Claude app: the hour most sessions start at.
  const starts = new Map();
  for (const e of M) {
    sessions.add(e.session);
    if (!(starts.get(e.session) <= e.ts)) starts.set(e.session, e.ts);
  }
  const hours = new Array(24).fill(0);
  for (const d of starts.values()) hours[d.getHours()]++;

  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const models = new Map();
  for (const e of R) {
    sessions.add(e.session);
    activeDays.add(dayKey(e.ts));
  }
  for (const e of L) {
    const u = e.usage;
    tokens.input += u.input_tokens || 0;
    tokens.output += u.output_tokens || 0;
    tokens.cacheWrite += u.cache_creation_input_tokens || 0;
    tokens.cacheRead += u.cache_read_input_tokens || 0;
    if (e.model && !e.model.startsWith('<')) models.set(e.model, (models.get(e.model) || 0) + (u.output_tokens || 0));
  }

  const toolCounts = new Map();
  for (const e of T) {
    const n = toolName(e.name);
    toolCounts.set(n, (toolCounts.get(n) || 0) + 1);
  }
  const byModel = [...models.entries()].sort((a, b) => b[1] - a[1]);

  return {
    range,
    toolCalls: T.length,
    topTools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]),
    models: byModel.map(([model, output]) => ({ model, output })),
    longestStreak: longestStreak(activeDays),
    sessions: sessions.size,
    prompts: P.length,
    messages: M.length,
    responses: R.length,
    tokens,
    tokensTotal: tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead,
    activeDays: activeDays.size,
    peakHour: starts.size ? hours.indexOf(Math.max(...hours)) : null, // hour most sessions start at
    favoriteModel: byModel[0]?.[0] ?? null, // most output
  };
}

// Prompts per local day, for the heatmap (always the full history).
export function dailyCounts({ prompts }) {
  const map = new Map();
  for (const e of prompts) {
    const k = dayKey(e.ts);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

export { dayKey };
