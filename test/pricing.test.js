import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, responseCost, totalCost } from '../src/pricing.js';

const usage = (u) => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u });

test('model ids resolve to their price, whatever the prefix or suffix', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('us.anthropic.claude-opus-4-8[1m]').input, 5);
  assert.equal(priceFor('claude-opus-4-1-20250805').input, 15);
  assert.equal(priceFor('claude-sonnet-4-5-20250929').input, 3);
  assert.equal(priceFor('claude-sonnet-5-5').input, 2);
  assert.equal(priceFor('claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(priceFor('claude-fable-5').cacheRead, 1);
  assert.equal(priceFor('<synthetic>'), null);
});

test('each token kind is priced at its own rate', () => {
  // 1M of each on Opus 5.5: 4 input + 5 (5m write) + 8 (1h write) + 0.2 read + 20 output
  const u = usage({ input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_write_5m: 1e6, cache_write_1h: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 });
  assert.equal(+responseCost({ model: 'claude-opus-5-5', usage: u }).toFixed(6), 37.2);
});

test('cache writes without a lifetime split count as 5-minute writes', () => {
  const u = usage({ cache_creation_input_tokens: 1e6 });
  assert.equal(responseCost({ model: 'claude-sonnet-4-6', usage: u }), 3.75);
});

test('fast mode doubles the price and web searches are added', () => {
  const u = usage({ output_tokens: 1e6 });
  assert.equal(responseCost({ model: 'claude-opus-5-5', usage: u, speed: 'fast' }), 40);
  assert.equal(responseCost({ model: 'claude-opus-5-5', usage: u, webSearches: 100 }), 21);
});

test('the total covers the window only and reports unknown models', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const r = (daysAgo, model = 'claude-haiku-4-5') => ({ ts: new Date(now - daysAgo * 86400e3), model, usage: usage({ output_tokens: 1e6 }) });
  const t = totalCost({ responses: [r(1), r(29), r(31), r(2, 'mystery-model')] }, { now });
  assert.equal(t.usd, 10);
  assert.equal(t.unpriced, 1);
  assert.equal(t.days, 30);
});
