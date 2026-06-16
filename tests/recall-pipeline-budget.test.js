import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyRecallBudget } from '../lib/recall-budget.js';

describe('applyRecallBudget – H1-06 associative cap', () => {
  it('caps associative memories at 30% of the budget', () => {
    const memories = [
      { entry: { id: 'v1', category: 'fact' }, score: 0.9, source: 'vector' },
      { entry: { id: 'v2', category: 'fact' }, score: 0.8, source: 'vector' },
      { entry: { id: 'v3', category: 'fact' }, score: 0.7, source: 'vector' },
      { entry: { id: 'v4', category: 'fact' }, score: 0.6, source: 'vector' },
      { entry: { id: 'v5', category: 'fact' }, score: 0.5, source: 'vector' },
      { entry: { id: 'v6', category: 'fact' }, score: 0.4, source: 'vector' },
      { entry: { id: 'v7', category: 'fact' }, score: 0.3, source: 'vector' },
      { entry: { id: 'g1', category: 'fact' }, score: 0.95, source: 'graph', depth: 1 },
      { entry: { id: 'g2', category: 'fact' }, score: 0.94, source: 'graph', depth: 1 },
      { entry: { id: 'g3', category: 'fact' }, score: 0.93, source: 'graph', depth: 1 },
      { entry: { id: 'g4', category: 'fact' }, score: 0.92, source: 'graph', depth: 1 },
    ];
    const result = applyRecallBudget(memories, { budget: 10 });
    assert.strictEqual(result.selected.length, 10);
    const assocCount = result.selected.filter(r => r.source === 'graph').length;
    assert.strictEqual(assocCount, 3, 'associative must be capped at 30% of budget');
  });

  it('prioritizes core memories', () => {
    const memories = [
      { entry: { id: 'core1', coreMemoryScore: 0.9 }, score: 0.5, source: 'vector' },
      { entry: { id: 'v1' }, score: 0.9, source: 'vector' },
    ];
    const result = applyRecallBudget(memories, { budget: 1 });
    assert.deepStrictEqual(result.selected.map(r => r.entry.id), ['core1']);
  });
});
