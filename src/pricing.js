// Estimates what Claude Code usage would cost at Anthropic API list prices,
// the same way Claude Code's own cost display does. On a Pro/Max plan this is
// the API value of the usage, not what the subscription costs.

// USD per million tokens. Cache writes are priced from `input` (1.25x for the
// 5-minute cache, 2x for the 1-hour cache); cache reads have their own rate.
// Most specific patterns first: the first match wins.
const PRICES = [
  [/^(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1 }],
  [/^opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^opus-4/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/^(3-opus|opus-3)/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/^sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^(sonnet-4|3-7-sonnet|3-5-sonnet)/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/^(3-5-haiku|haiku-3-5)/, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/^(3-haiku|haiku-3)/, { input: 0.25, output: 1.25, cacheRead: 0.03 }],
];

const WEB_SEARCH = 10 / 1000; // $10 per 1,000 searches
const FAST_MULTIPLIER = 2; // fast mode is priced at twice the standard rates

// "us.anthropic.claude-opus-4-8[1m]" → "opus-4-8"
export function priceFor(model) {
  const id = String(model || '').toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/^.*claude-/, '')
    .replace(/[@-]\d{8}$/, '');
  return PRICES.find(([re]) => re.test(id))?.[1] ?? null;
}

// Cost of one response in USD, or null when the model has no known price.
export function responseCost({ model, usage: u, speed, webSearches = 0 }) {
  const p = priceFor(model);
  if (!p) return null;
  // Older transcripts only have the cache-write total: price it as 5-minute writes.
  const w1h = u.cache_write_1h ?? 0;
  const w5m = u.cache_write_5m ?? Math.max(0, u.cache_creation_input_tokens - w1h);
  const tokens =
    u.input_tokens * p.input +
    w5m * p.input * 1.25 +
    w1h * p.input * 2 +
    u.cache_read_input_tokens * p.cacheRead +
    u.output_tokens * p.output;
  return (tokens / 1e6) * (speed === 'fast' ? FAST_MULTIPLIER : 1) + webSearches * WEB_SEARCH;
}

// Total over the last `days` days, subagents included (they are billed too).
export function totalCost({ responses }, { days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * 86400000;
  let usd = 0, unpriced = 0;
  for (const r of responses) {
    if (r.ts.getTime() < since || r.ts > now) continue;
    const c = responseCost(r);
    if (c == null) unpriced++;
    else usd += c;
  }
  return { usd, days, unpriced };
}
