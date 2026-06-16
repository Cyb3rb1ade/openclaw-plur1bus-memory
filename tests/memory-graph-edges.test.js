import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdgesForSession } from '../lib/memory-graph.js';

async function runWithRows(newMemories, existingRows) {
  const dbTable = {
    vectorSearch: () => ({ limit: () => ({ toArray: async () => existingRows }) }),
  };
  return buildEdgesForSession(newMemories, existingRows, dbTable, null);
}

describe('buildEdgesForSession – H1-04 edge quality', () => {
  it('entity edges require at least 2 shared tokens', async () => {
    const existing = [{ id: 'e1', topics: ['api', 'memory'], createdAt: new Date().toISOString() }];
    const mem = { id: 'm1', topics: ['memory'], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const entityEdges = edges.filter(e => e.type === 'entity');
    assert.strictEqual(entityEdges.length, 0, 'single-token overlap must not create entity edge');
  });

  it('entity edges require jaccard >= 0.5', async () => {
    const existing = [{ id: 'e1', topics: ['a', 'b', 'c', 'd'], createdAt: new Date().toISOString() }];
    const mem = { id: 'm1', topics: ['a', 'b', 'x', 'y', 'z'], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const entityEdges = edges.filter(e => e.type === 'entity' && (e.source === 'm1' || e.target === 'm1'));
    assert.strictEqual(entityEdges.length, 0, 'jaccard 2/7 < 0.5 must not create edge');
  });

  it('emotional edges require shared content token', async () => {
    const existing = [
      { id: 'e1', emotionalDominant: 'joy', emotionalIntensity: 0.8, topics: [], createdAt: new Date().toISOString() },
    ];
    const mem = { id: 'm1', emotionalDominant: 'joy', emotionalIntensity: 0.8, topics: ['party'], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const emotionalEdges = edges.filter(e => e.type === 'emotional');
    assert.strictEqual(emotionalEdges.length, 0, 'same emotion without shared token must not create edge');
  });

  it('strong emotional edges with shared token are weaker than semantic edges', async () => {
    const existing = [
      { id: 'e1', emotionalDominant: 'joy', emotionalIntensity: 1.0, topics: ['party'], createdAt: new Date().toISOString() },
    ];
    const mem = { id: 'm1', emotionalDominant: 'joy', emotionalIntensity: 1.0, topics: ['party'], createdAt: new Date().toISOString() };
    const edges = await runWithRows([mem], existing);
    const emotional = edges.find(e => e.type === 'emotional');
    assert.ok(emotional, 'shared-token emotional edge should exist');
    assert.ok(emotional.strength <= 0.5, `emotional edge strength ${emotional.strength} must be <= 0.5`);
  });
});
