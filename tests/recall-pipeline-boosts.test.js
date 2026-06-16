import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyImportanceBoost } from '../lib/recall-pipeline.js';

describe('applyImportanceBoost – H1-07 additive discipline', () => {
  it('uses additive boost, not multiplicative', () => {
    const results = [
      { entry: { id: 'a', importance: 1.0 }, score: 0.50 },
      { entry: { id: 'b', importance: 0.5 }, score: 0.49 },
    ];
    const boosted = applyImportanceBoost(results, 0.3);
    const a = boosted.find(r => r.entry.id === 'a');
    const b = boosted.find(r => r.entry.id === 'b');
    // additive: a = 0.50 + (1.0 - 0.5)*0.3 = 0.65 ; b = 0.49 + 0 = 0.49
    assert.ok(a.score > b.score, 'higher-importance item with much lower relevance must not overtake');
    assert.ok(Math.abs(a.score - 0.65) < 1e-9, `expected 0.65, got ${a.score}`);
    assert.ok(Math.abs(b.score - 0.49) < 1e-9, `expected 0.49, got ${b.score}`);
  });

  it('returns unchanged results when boost is 0', () => {
    const results = [{ entry: { id: 'a', importance: 1.0 }, score: 0.5 }];
    const boosted = applyImportanceBoost(results, 0);
    assert.strictEqual(boosted[0].score, 0.5);
  });
});
