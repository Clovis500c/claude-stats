// Renders the stats card as a standalone SVG (no external fonts or images,
// so it displays inside a GitHub README). Written for profile visitors.
import { dayKey } from './collect.js';
import { pickBook } from './books.js';

const THEMES = {
  dark: {
    bg: '#262624', tile: '#30302e', rule: '#3a3a37', label: '#8e8d88', value: '#e8e6e0', title: '#f5f4ef',
    muted: '#8e8d88', empty: '#363634',
    // tokens bar: generated (accent), added to context, re-read from cache
    tok: ['#6f9ef0', '#57574f'],
    series: ['#6f9ef0', '#b7b4aa', '#6b6a64'],
  },
  light: {
    bg: '#faf9f5', tile: '#f0eee6', rule: '#e3e0d6', label: '#7a776f', value: '#1f1e1d', title: '#141413',
    muted: '#7a776f', empty: '#e6e4da',
    tok: ['#5289ea', '#cfccc1'],
    series: ['#5289ea', '#9d9a90', '#cfccc1'],
  },
};

// Heatmap scales, low → high activity, for dark and light backgrounds.
export const PALETTES = {
  blue: { dark: ['#8db3f4', '#6f9ef0', '#4f86e8', '#2563d9'], light: ['#a9c7f7', '#7fa9f2', '#5289ea', '#2563d9'] },
  green: { dark: ['#0e4429', '#006d32', '#26a641', '#39d353'], light: ['#9be9a8', '#40c463', '#30a14e', '#216e39'] },
  orange: { dark: ['#f4c7b0', '#eba483', '#e0825a', '#c9602f'], light: ['#f6d3c1', '#efb294', '#e48d66', '#c9602f'] },
  purple: { dark: ['#cdbdf7', '#ad97f0', '#8c70e6', '#6b4bd8'], light: ['#dccff9', '#bba7f2', '#9a7fe8', '#6b4bd8'] },
  pink: { dark: ['#f7bdd8', '#f096c0', '#e46ea6', '#cc4589'], light: ['#f9d3e5', '#f2a9cb', '#e67daf', '#cc4589'] },
  gray: { dark: ['#6b6a64', '#8e8d88', '#b7b4aa', '#e8e6e0'], light: ['#cfccc1', '#a9a69c', '#7a776f', '#3d3c38'] },
};

export const SECTIONS = ['header', 'tiles', 'heatmap', 'book', 'tokens', 'models', 'tools'];

export const TILES = ['sessions', 'messages', 'prompts', 'activeDays', 'streak', 'generated', 'toolCalls', 'peakHour', 'favorite', 'responses', 'processed'];
export const DEFAULT_TILES = TILES.filter((k) => k !== 'prompts').slice(0, 8);

const I18N = {
  en: {
    locale: 'en-US',
    title: 'Claude Code usage',
    range: { all: 'All time', '30d': 'Last 30 days', '7d': 'Last 7 days' },
    updated: (d) => `updated ${d}`,
    sessions: 'Sessions', messages: 'Messages', prompts: 'Prompts', activeDays: 'Active days', streak: 'Longest streak',
    generated: 'Tokens generated', toolCalls: 'Tool calls', peakHour: 'Peak hour', favorite: 'Favorite model',
    responses: 'Claude responses', processed: 'Tokens processed',
    days: (n) => `${n} day${n === 1 ? '' : 's'}`,
    hour: (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`,
    book: (n, title) => `Claude wrote ≈ ${n}× the length of ${title}`,
    less: 'Less', more: 'More',
    tokens: 'Tokens', processedTotal: (n) => `${n} processed in total`,
    // spend banner: say plainly it's an estimate at API prices, not money paid
    period: { '30d': 'last 30 days', '5m': 'last 5 months', '1y': 'last 12 months' },
    spent: (period) => `worth of usage · ${period}`, apiPrices: 'at API prices, not the amount paid',
    tokGenerated: 'Written by Claude', tokAdded: 'Added to context', tokReread: 'Re-read from cache',
    models: 'Models', byOutput: 'share of generated tokens',
    tiers: { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', diamond: 'Diamond', legendary: 'Legendary' },
    tools: 'Top tools', other: 'Other',
  },
  fr: {
    locale: 'fr-FR',
    title: 'Utilisation de Claude Code',
    range: { all: 'Depuis le début', '30d': '30 derniers jours', '7d': '7 derniers jours' },
    updated: (d) => `mis à jour le ${d}`,
    sessions: 'Sessions', messages: 'Messages', prompts: 'Prompts', activeDays: 'Jours actifs', streak: 'Plus longue série',
    generated: 'Tokens générés', toolCalls: "Appels d'outils", peakHour: 'Heure de pointe', favorite: 'Modèle favori',
    responses: 'Réponses de Claude', processed: 'Tokens traités',
    days: (n) => `${n} jour${n > 1 ? 's' : ''}`,
    hour: (h) => `${String(h).padStart(2, '0')} h`,
    book: (n, title) => `Claude a écrit ≈ ${n}× la longueur ${title}`,
    less: 'Moins', more: 'Plus',
    tokens: 'Tokens', processedTotal: (n) => `${n} traités au total`,
    period: { '30d': '30 derniers jours', '5m': '5 derniers mois', '1y': '12 derniers mois' },
    spent: (period) => `d'utilisation · ${period}`, apiPrices: 'au tarif API, pas le montant payé',
    tokGenerated: 'Écrits par Claude', tokAdded: 'Ajoutés au contexte', tokReread: 'Relus depuis le cache',
    models: 'Modèles', byOutput: 'part des tokens générés',
    tiers: { bronze: 'Bronze', silver: 'Argent', gold: 'Or', diamond: 'Diamant', legendary: 'Légendaire' },
    tools: 'Outils les plus utilisés', other: 'Autres',
  },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const DEFAULT_ACCENT = '#d97757';

// Claude logo (24×24 path) from Simple Icons v16.32.0, https://simpleicons.org (CC0).
// Claude is a trademark of Anthropic; used here only to identify the product.
const CLAUDE_LOGO = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function prettyModel(id) {
  if (!id) return '—';
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const family = parts.shift();
  return `${family[0].toUpperCase()}${family.slice(1)} ${parts.join('.')}`.trim();
}

export function compact(n) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// Accepts "#d97757", "d97757" or "#abc"; returns null when invalid.
export function parseColor(s) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s ?? '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

// Spend tiers by API value over the window: the more spent, the shinier the banner.
// stops run left → right; text sits on the left, so the first stop sets the contrast.
const TIERS = [
  { min: 0, key: 'bronze', stops: ['#9a5a30', '#ad6a38', '#7a4220'], ink: '#ffffff', shine: 0.2, sparkles: 0 },
  { min: 100, key: 'silver', stops: ['#c3cad2', '#f4f6f8', '#9aa3ad'], ink: '#1f2328', shine: 0.55, sparkles: 0 },
  { min: 500, key: 'gold', stops: ['#e9b949', '#f9e08a', '#c9962f'], ink: '#3b2a06', shine: 0.6, sparkles: 3, glow: '#f2c14e' },
  { min: 1500, key: 'diamond', stops: ['#8fd3f7', '#e6f8ff', '#7f9cff'], ink: '#0b2540', shine: 0.75, sparkles: 5, glow: '#7fd3ff' },
  // flowing rainbow: first and last stop match so the loop is seamless
  { min: 5000, key: 'legendary', stops: ['#c2185b', '#6a1b9a', '#1565c0', '#00897b', '#c2185b'], ink: '#ffffff', shine: 0.35, sparkles: 7, glow: '#b06cff', flow: true },
];
export const spendTier = (usd) => TIERS.findLast((x) => usd >= x.min);

// Sparkle spots as fractions of the banner, kept off the text and the tier pill.
const SPARKS = [[0.68, 0.22, 6.5], [0.72, 0.8, 4.5], [0.63, 0.88, 4], [0.79, 0.15, 5], [0.6, 0.12, 3.5], [0.9, 0.84, 5], [0.97, 0.2, 4]];
const star = (x, y, r) => `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;

// SVG can't measure text; a rough per-character width is enough for layout.
const textW = (s, size) => String(s).length * size * 0.52;

// Intensity relative to the busiest day: most days light, peaks dark.
function levels(counts) {
  const max = Math.max(0, ...counts.values());
  return (x) => (x <= 0 ? 0 : Math.min(4, Math.ceil((x / max) * 4)));
}

export function renderCard(stats, counts, opts = {}) {
  const {
    theme = 'dark', lang = 'en', name, title, now = new Date(),
    palette = 'blue', accent = DEFAULT_ACCENT, transparent = false,
    weeks = 26, hide = [], tiles: tileKeys = DEFAULT_TILES, cost = null,
  } = opts;
  const c = THEMES[theme] || THEMES.dark;
  const t = I18N[lang] || I18N.en;
  const show = (s) => !hide.includes(s);
  const cells = [c.empty, ...(PALETTES[palette] || PALETTES.blue)[theme === 'light' ? 'light' : 'dark']];
  const acc = parseColor(accent) || DEFAULT_ACCENT;
  const num = (n) => n.toLocaleString(t.locale);
  const pct = (x) => (x > 0 && x < 0.001 ? '<0.1%' : `${x >= 0.995 ? 100 : x >= 0.1 ? Math.round(x * 100) : +(x * 100).toFixed(1)}%`);
  const W = 520, pad = 16, inner = W - pad * 2;
  const out = [];
  const text = (x, y, s, { size = 11, fill = c.muted, weight, anchor } = {}) =>
    out.push(`<text x="${+x.toFixed(1)}" y="${+y.toFixed(1)}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''} fill="${fill}">${esc(s)}</text>`);
  const rect = (x, y, w, h, fill, rx = 0) =>
    out.push(`<rect x="${+x.toFixed(1)}" y="${+y.toFixed(1)}" width="${+w.toFixed(1)}" height="${+h.toFixed(1)}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"/>`);

  // Blocks are laid out top to bottom; `y` is the bottom of what's drawn so far.
  let y = pad;
  let first = true;
  const gapBefore = (n) => { if (!first) y += n; first = false; };

  // Section title with a note on the right and a thin rule above it.
  const section = (title, note) => {
    gapBefore(14);
    if (y > pad) rect(pad, y, inner, 1, c.rule);
    y += 20;
    text(pad, y, title, { size: 12, fill: c.value, weight: 600 });
    if (note) text(W - pad, y, note, { anchor: 'end' });
  };

  // Horizontal stacked bar + legend underneath. Tiny parts keep a 3px sliver
  // so they stay visible; the legend carries the exact numbers.
  const stacked = (parts) => {
    const by = y + 12;
    const total = parts.reduce((s, p) => s + p.value, 0) || 1;
    const vis = parts.filter((p) => p.value > 0);
    const widths = vis.map((p) => Math.max(3, (p.value / total) * inner));
    const scale = inner / widths.reduce((a, b) => a + b, 0);
    out.push(`<clipPath id="bar${by}"><rect x="${pad}" y="${by}" width="${inner}" height="8" rx="4"/></clipPath><g clip-path="url(#bar${by})">`);
    let x = pad;
    vis.forEach((p, i) => { rect(x, by, widths[i] * scale, 8, p.color); x += widths[i] * scale; });
    out.push('</g>');
    // Legend in equal columns; the value is a tspan so it sits right after
    // the label whatever the font's real widths are.
    const col = inner / parts.length;
    const ly = by + 24;
    parts.forEach((p, i) => {
      const lx = pad + i * col;
      out.push(`<circle cx="${+(lx + 4).toFixed(1)}" cy="${ly - 4}" r="4" fill="${p.color}"/>`);
      out.push(`<text x="${+(lx + 12).toFixed(1)}" y="${ly}" font-size="11" fill="${c.muted}">${esc(p.label)} <tspan font-weight="600" fill="${c.value}">${esc(p.note)}</tspan></text>`);
    });
    y = ly + 2;
  };

  // ---- Header ----
  if (show('header')) {
    gapBefore(0);
    out.push(`<path transform="translate(${pad + 1} ${y + 1}) scale(1.25)" fill="${acc}" d="${CLAUDE_LOGO}"/>`);
    text(pad + 44, y + 14, title || t.title, { size: 16, fill: c.title, weight: 600 });
    const date = now.toLocaleDateString(t.locale, { month: 'short', day: 'numeric', year: 'numeric' });
    text(pad + 44, y + 30, [name && `@${name}`, t.range[stats.range] || t.range.all, t.updated(date)].filter(Boolean).join(' · '), { size: 11.5 });
    y += 32;
  }

  // ---- Spend banner (opt-in): API value of the usage over the last N days, styled by tier ----
  if (cost) {
    gapBefore(16);
    const bh = 58;
    // tier from the amount shown, over the window the user picked
    const tier = spendTier(cost.usd);
    const { ink, stops } = tier;
    const dark = ink === '#ffffff';
    const grad = tier.flow
      // twice as wide and slid left by one width, repeating: an endless flow
      ? `<linearGradient id="spend" gradientUnits="userSpaceOnUse" x1="${pad}" y1="0" x2="${pad + inner}" y2="0" spreadMethod="repeat">`
      : '<linearGradient id="spend" x1="0" y1="0" x2="1" y2="1">';
    out.push(`<defs>${grad}${stops.map((s, i) => `<stop offset="${+(i / (stops.length - 1)).toFixed(3)}" stop-color="${s}"/>`).join('')}</linearGradient>`
      + `<linearGradient id="spend-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="${tier.shine}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
      + `<clipPath id="spend-clip"><rect x="${pad}" y="${y}" width="${inner}" height="${bh}" rx="10"/></clipPath>`
      + (tier.glow ? '<filter id="spend-glow" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>' : '')
      + '</defs>');
    out.push(`<style>
@keyframes cs-shine { 0% { transform: translateX(0) } 55%, 100% { transform: translateX(${W + 240}px) } }
@keyframes cs-twinkle { 0%, 100% { opacity: 0; transform: scale(.3) rotate(0deg) } 50% { opacity: 1; transform: scale(1) rotate(45deg) } }
@keyframes cs-flow { to { transform: translateX(-${inner}px) } }
.cs-shine { animation: cs-shine 4.5s ease-in-out infinite }
.cs-spark { transform-box: fill-box; transform-origin: center; animation: cs-twinkle 2.6s ease-in-out infinite both }
.cs-flow { animation: cs-flow 8s linear infinite }
@media (prefers-reduced-motion: reduce) { .cs-shine, .cs-spark, .cs-flow { animation: none } .cs-shine { display: none } }
</style>`);
    if (tier.glow) out.push(`<rect x="${pad + 6}" y="${y + 8}" width="${inner - 12}" height="${bh - 8}" rx="10" fill="${tier.glow}" opacity="0.45" filter="url(#spend-glow)"/>`);
    out.push('<g clip-path="url(#spend-clip)">');
    if (tier.flow) out.push(`<g class="cs-flow"><rect x="${pad}" y="${y}" width="${inner * 2}" height="${bh}" fill="url(#spend)"/></g>`);
    else rect(pad, y, inner, bh, 'url(#spend)');
    // soft highlight across the top half, then a glint sweeping across
    out.push(`<rect x="${pad}" y="${y}" width="${inner}" height="${bh / 2}" fill="#ffffff" fill-opacity="0.1"/>`);
    out.push(`<g class="cs-shine"><rect x="-150" y="${y - 10}" width="90" height="${bh + 20}" fill="url(#spend-shine)" transform="skewX(-20)"/></g>`);
    SPARKS.slice(0, tier.sparkles).forEach(([fx, fy, r], i) => {
      out.push(`<path class="cs-spark" style="animation-delay:${(i * 0.37).toFixed(2)}s" d="${star(+(pad + fx * inner).toFixed(1), +(y + fy * bh).toFixed(1), r)}" fill="#ffffff"/>`);
    });
    out.push(`<rect x="${pad + 0.5}" y="${y + 0.5}" width="${inner - 1}" height="${bh - 1}" rx="9.5" fill="none" stroke="#ffffff" stroke-opacity="${dark ? 0.25 : 0.6}"/>`);
    out.push('</g>');

    const usd = cost.usd.toLocaleString(t.locale, {
      style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: cost.usd >= 1000 ? 0 : 2, minimumFractionDigits: cost.usd >= 1000 ? 0 : 2,
    });
    // a 1px offset copy gives the amount some depth: dark under light text, light under dark text
    out.push(`<text x="${pad + 16}" y="${y + 39}" font-size="26" font-weight="800" fill="${dark ? '#000000' : '#ffffff'}" fill-opacity="${dark ? 0.3 : 0.6}">${esc(usd)}</text>`);
    text(pad + 16, y + 38, usd, { size: 26, fill: ink, weight: 800 });
    const lx = pad + 16 + textW(usd, 26) * 1.08 + 12; // heavy weight runs wider than textW
    text(lx, y + 26, t.spent(t.period[cost.period] ?? t.period['30d']), { size: 12, fill: ink, weight: 600 });
    out.push(`<text x="${+lx.toFixed(1)}" y="${y + 42}" font-size="11" fill="${ink}" fill-opacity="0.8">${esc(t.apiPrices)}</text>`);

    // tier pill on the right
    const label = t.tiers[tier.key].toUpperCase();
    const pw = textW(label, 11) * 1.2 + 36, px = pad + inner - 14 - pw, py = y + (bh - 24) / 2;
    out.push(`<rect x="${+px.toFixed(1)}" y="${py}" width="${+pw.toFixed(1)}" height="24" rx="12" fill="${ink}" fill-opacity="0.12" stroke="${ink}" stroke-opacity="0.3"/>`);
    out.push(`<path d="${star(+(px + 14).toFixed(1), py + 12, 5.5)}" fill="${ink}"/>`);
    out.push(`<text x="${+(px + 23).toFixed(1)}" y="${py + 16}" font-size="11" font-weight="700" letter-spacing="1" fill="${ink}">${esc(label)}</text>`);
    y += bh;
  }

  // ---- Stat tiles ----
  const tileValue = {
    sessions: () => num(stats.sessions),
    messages: () => num(stats.messages),
    prompts: () => num(stats.prompts),
    activeDays: () => num(stats.activeDays),
    streak: () => t.days(stats.longestStreak),
    generated: () => compact(stats.tokens.output),
    toolCalls: () => num(stats.toolCalls),
    peakHour: () => (stats.peakHour == null ? '—' : t.hour(stats.peakHour)),
    favorite: () => prettyModel(stats.favoriteModel),
    responses: () => num(stats.responses),
    processed: () => compact(stats.tokensTotal),
  };
  const keys = tileKeys.filter((k) => tileValue[k]);
  if (show('tiles') && keys.length) {
    gapBefore(16);
    const gap = 6, cols = Math.min(4, keys.length), tw = (inner - gap * (cols - 1)) / cols, th = 46;
    keys.forEach((k, i) => {
      const x = pad + (i % cols) * (tw + gap);
      const ty = y + Math.floor(i / cols) * (th + gap);
      rect(x, ty, tw, th, c.tile, 6);
      text(x + 9, ty + 18, t[k], { size: 11, fill: c.label });
      text(x + 9, ty + 37, tileValue[k](), { size: 15, fill: c.value, weight: 600 });
    });
    y += Math.ceil(keys.length / cols) * (th + gap) - gap;
  }

  // ---- Heatmap: columns = weeks (oldest → current), rows = Sunday → Saturday ----
  if (show('heatmap')) {
    const wasFirst = first;
    gapBefore(22);
    const my = y + (wasFirst ? 10 : 0);
    const hy = my + 6;
    const cgap = weeks > 40 ? 2 : 3;
    const step = (inner + cgap) / weeks, cell = step - cgap;
    const level = levels(counts);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
    // Month labels where each month starts; one with no room before the next is dropped.
    const monthCols = [];
    for (let w = 0; w < weeks; w++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7);
      if (!monthCols.length || d.getMonth() !== monthCols.at(-1).date.getMonth()) monthCols.push({ w, date: d });
    }
    const minCols = Math.ceil(28 / step);
    monthCols.forEach(({ w, date }, i) => {
      if ((monthCols[i + 1]?.w ?? weeks + minCols) - w < minCols) return;
      text(pad + w * step, my, date.toLocaleDateString(t.locale, { month: 'short' }).replace('.', ''), { size: 10.5 });
    });
    const rx = cell > 10 ? 3 : 2;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + w * 7 + d);
        if (day > today) continue;
        rect(pad + w * step, hy + d * step, cell, cell, cells[level(counts.get(dayKey(day)) || 0)], rx);
      }
    }
    y = hy + 7 * step - cgap;
  }

  // Book comparison (left) and heatmap legend (right) share one line.
  const book = pickBook(stats.tokens.output);
  const showBook = show('book') && book.ratio >= 0.1;
  if (showBook || show('heatmap')) {
    gapBefore(16);
    const fy = y + 1;
    if (showBook) {
      const n = book.ratio >= 10 ? num(Math.round(book.ratio)) : book.ratio.toLocaleString(t.locale, { maximumFractionDigits: 1 });
      text(pad, fy, t.book(n, book[lang] || book.en));
    }
    if (show('heatmap')) {
      let lx = W - pad;
      text(lx, fy, t.more, { anchor: 'end' });
      lx -= textW(t.more, 11) + 5;
      for (let i = 4; i >= 0; i--) { lx -= 10; rect(lx, fy - 9, 10, 10, cells[i], 2); lx -= 3; }
      text(lx - 3, fy, t.less, { anchor: 'end' });
    }
    y = fy + 3;
  }

  // ---- Tokens ----
  if (show('tokens')) {
    const tk = stats.tokens;
    section(t.tokens, t.processedTotal(compact(stats.tokensTotal)));
    stacked([
      { label: t.tokGenerated, value: tk.output, note: compact(tk.output), color: acc },
      { label: t.tokAdded, value: tk.input + tk.cacheWrite, note: compact(tk.input + tk.cacheWrite), color: c.tok[0] },
      { label: t.tokReread, value: tk.cacheRead, note: compact(tk.cacheRead), color: c.tok[1] },
    ]);
  }

  // ---- Models ----
  if (show('models') && stats.models.length) {
    section(t.models, t.byOutput);
    const colors = [acc, ...c.series];
    const total = stats.models.reduce((s, m) => s + m.output, 0) || 1;
    const rest = stats.models.slice(3).reduce((s, m) => s + m.output, 0);
    const parts = stats.models.slice(0, 3).map((m, i) => ({ label: prettyModel(m.model), value: m.output, note: pct(m.output / total), color: colors[i] }));
    if (rest > 0) parts.push({ label: t.other, value: rest, note: pct(rest / total), color: colors[3] });
    stacked(parts);
  }

  // ---- Top tools, as chips ----
  if (show('tools') && stats.topTools.length) {
    section(t.tools, `${num(stats.toolCalls)} ${t.toolCalls.toLowerCase()}`);
    let cx = pad;
    const cy = y + 12;
    for (const [tool, n] of stats.topTools.slice(0, 5)) {
      const label = tool.length > 16 ? `${tool.slice(0, 15)}…` : tool;
      const w = textW(label, 11) + textW(compact(n), 11) + 24;
      if (cx + w > W - pad) break;
      rect(cx, cy, w, 22, c.tile, 11);
      text(cx + 10, cy + 15, label, { size: 11, fill: c.value });
      text(cx + w - 10, cy + 15, compact(n), { size: 11, weight: 600, anchor: 'end' });
      cx += w + 6;
    }
    y = cy + 22;
  }

  const H = Math.round(y + pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<title>${esc([name, title || t.title].filter(Boolean).join(' — '))}</title>
${transparent ? '' : `<rect width="${W}" height="${H}" rx="12" fill="${c.bg}"/>`}
${out.join('\n')}
</svg>
`;
}
