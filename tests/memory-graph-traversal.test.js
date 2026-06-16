import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traverseGraph, readGraph, DEFAULT_TRAVERSAL_CONFIG } from '../lib/memory-graph.js';

function makeEdge(source, target, strength = 0.9) {
  return { source, target, type: 'semantic', strength, directed: false };
}

describe('traverseGraph – H1-03 depth/relevance hardening', () => {
  it('default maxDepth is 2', () => {
    assert.strictEqual(DEFAULT_TRAVERSAL_CONFIG.maxDepth, 2);
  });

  it('scales min cumulative relevance with depth, dropping deeper weak paths', () => {
    // seed -> n1 (0.6) -> n2 (0.6). With default minCumulativeRelevance 0.2 and
    // depthRelevanceScale 0.5, depth-2 threshold is 0.2 * (1 + 2*0.5) = 0.4.
    // Cumulative after two edges = 0.6 * 0.6 = 0.36, so depth-2 item should be dropped.
    const edges = [makeEdge('seed', 'n1', 0.6), makeEdge('n1', 'n2', 0.6)];
    const { adjacency } = readGraph(edges);
    const seeds = [{ entry: { id: 'seed' }, score: 0.9 }];
    const results = traverseGraph(seeds, adjacency, DEFAULT_TRAVERSAL_CONFIG);
    const depth2 = results.find(r => r.memoryId === 'n2');
    assert.ok(!depth2, 'weak depth-2 path should be pruned by scaled threshold');
  });

  it('stronger deep paths still survive', () => {
    const edges = [makeEdge('seed', 'n1', 0.95), makeEdge('n1', 'n2', 0.95)];
    const { adjacency } = readGraph(edges);
    const seeds = [{ entry: { id: 'seed' }, score: 0.9 }];
    const results = traverseGraph(seeds, adjacency, DEFAULT_TRAVERSAL_CONFIG);
    const depth2 = results.find(r => r.memoryId === 'n2');
    assert.ok(depth2, 'strong depth-2 path should survive');
  });
});
