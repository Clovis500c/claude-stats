import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, prettyModel, compact, parseColor, SECTIONS } from '../src/render.js';
import { pickBook } from '../src/books.js';

const stats = {
  range: 'all', sessions: 12, prompts: 340, responses: 900, activeDays: 20, longestStreak: 6,
  toolCalls: 1500, peakHour: 15, favoriteModel: 'claude-opus-4-5',
  tokens: { input: 1e4, output: 2e6, cacheWrite: 3e5, cacheRead: 9e7 }, tokensTotal: 1e4 + 2e6 + 3e5 + 9e7,
  models: [{ model: 'claude-opus-4-5', output: 1.5e6 }, { model: 'claude-sonnet-4-5', output: 5e5 }],
  topTools: [['Bash', 700], ['Read', 500], ['Edit', 300]],
};
const counts = new Map([['2026-03-10', 4]]);
const now = new Date('2026-03-20T12:00:00');

test('renders a well-formed SVG with every section', () => {
  const svg = renderCard(stats, counts, { name: 'octocat', now });
  assert.match(svg, /^<svg [^>]*width="520"/);
  assert.match(svg, /<\/svg>\n$/);
  for (const s of ['@octocat', 'Top tools', 'Models', 'Tokens', 'Opus 4.5']) assert.ok(svg.includes(s), s);
});

test('escapes user text', () => {
  const svg = renderCard(stats, counts, { title: '<script>&', now });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&#60;script&#62;&#38;'));
});

test('hiding every section still renders', () => {
  const svg = renderCard(stats, counts, { hide: SECTIONS, now });
  assert.match(svg, /<svg /);
  assert.ok(!svg.includes('Top tools'));
});

test('light theme and French labels', () => {
  const svg = renderCard(stats, counts, { theme: 'light', lang: 'fr', now });
  assert.ok(svg.includes('#faf9f5'));
  assert.ok(svg.includes('Outils les plus utilisés'));
});

test('the spend banner only appears when asked for', () => {
  assert.ok(!renderCard(stats, counts, { now }).includes('id="spend"'));
  const svg = renderCard(stats, counts, { now, cost: { usd: 1234.5, days: 30 } });
  assert.ok(svg.includes('id="spend"'));
  assert.ok(svg.includes('$1,235'));
  assert.ok(svg.includes('spent in the last 30 days'));
  // light accent → dark text
  assert.ok(renderCard(stats, counts, { now, accent: '#39d353', cost: { usd: 5, days: 30 } }).includes('fill="#1f1e1d">$5.00'));
});

test('helpers', () => {
  assert.equal(prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(prettyModel(null), '—');
  assert.equal(compact(999), '999');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(2_000_000), '2M');
  assert.equal(parseColor('D97757'), '#d97757');
  assert.equal(parseColor('#abc'), '#abc');
  assert.equal(parseColor('red'), null);
});

test('book scale picks the largest book that fits 10 times', () => {
  assert.equal(pickBook(0).en, 'The Great Gatsby');
  const b = pickBook(12 * 481_103 * 1.3);
  assert.equal(b.en, 'The Lord of the Rings');
  assert.ok(b.ratio >= 10);
});
