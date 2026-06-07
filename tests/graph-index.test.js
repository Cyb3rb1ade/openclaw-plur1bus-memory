import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildGraphIndex, queryGraphIndex } from '../lib/graph-index.js';

describe('graph-index', () => {
  describe('buildGraphIndex', () => {
    it('baut alle Indizes korrekt auf', () => {
      const edges = [
        { id: 'e1', type: 'depends_on', source: 'a', target: 'b', weight: 1 },
        { id: 'e2', type: 'depends_on', source: 'c', target: 'b', weight: 1 },
        { id: 'e3', type: 'related_to', source: 'a', target: 'd', weight: 0.5 },
      ];

      const index = buildGraphIndex(edges);

      assert.ok(index.byType);
      assert.ok(index.byTarget);
      assert.ok(index.bySource);
      assert.ok(index.byTypeAndTarget);

      assert.deepStrictEqual(index.byType.get('depends_on'), [edges[0], edges[1]]);
      assert.deepStrictEqual(index.byType.get('related_to'), [edges[2]]);

      assert.deepStrictEqual(index.byTarget.get('b'), [edges[0], edges[1]]);
      assert.deepStrictEqual(index.byTarget.get('d'), [edges[2]]);

      assert.deepStrictEqual(index.bySource.get('a'), [edges[0], edges[2]]);
      assert.deepStrictEqual(index.bySource.get('c'), [edges[1]]);

      assert.deepStrictEqual(index.byTypeAndTarget.get('depends_on:b'), [edges[0], edges[1]]);
      assert.deepStrictEqual(index.byTypeAndTarget.get('related_to:d'), [edges[2]]);
    });

    it('gibt leere Indizes bei leerem Input', () => {
      const index = buildGraphIndex([]);
      assert.strictEqual(index.byType.size, 0);
      assert.strictEqual(index.byTarget.size, 0);
      assert.strictEqual(index.bySource.size, 0);
      assert.strictEqual(index.byTypeAndTarget.size, 0);
    });
  });

  describe('queryGraphIndex', () => {
    const edges = [
      { id: 'e1', type: 'depends_on', source: 'a', target: 'b', weight: 1 },
      { id: 'e2', type: 'depends_on', source: 'c', target: 'b', weight: 1 },
      { id: 'e3', type: 'related_to', source: 'a', target: 'd', weight: 0.5 },
    ];
    const index = buildGraphIndex(edges);

    it('filtert nach type', () => {
      const result = queryGraphIndex(index, { type: 'depends_on' });
      assert.deepStrictEqual(result, [edges[0], edges[1]]);
    });

    it('filtert nach target', () => {
      const result = queryGraphIndex(index, { target: 'b' });
      assert.deepStrictEqual(result, [edges[0], edges[1]]);
    });

    it('filtert nach source', () => {
      const result = queryGraphIndex(index, { source: 'a' });
      assert.deepStrictEqual(result, [edges[0], edges[2]]);
    });

    it('nutzt kombinierten type+target Index', () => {
      const result = queryGraphIndex(index, { type: 'depends_on', target: 'b' });
      assert.deepStrictEqual(result, [edges[0], edges[1]]);
    });

    it('gibt alle Edges zurück, wenn nichts gegeben', () => {
      const result = queryGraphIndex(index, {});
      assert.deepStrictEqual(result, edges);
    });

    it('gibt leeres Array bei unbekanntem Filter', () => {
      assert.deepStrictEqual(queryGraphIndex(index, { type: 'nonexistent' }), []);
      assert.deepStrictEqual(queryGraphIndex(index, { target: 'nonexistent' }), []);
      assert.deepStrictEqual(queryGraphIndex(index, { source: 'nonexistent' }), []);
      assert.deepStrictEqual(queryGraphIndex(index, { type: 'depends_on', target: 'nonexistent' }), []);
    });
  });

  describe('Performance', () => {
    it('indexiert 10k Edges in unter 100ms', () => {
      const edges = [];
      for (let i = 0; i < 10000; i++) {
        edges.push({
          id: `e${i}`,
          type: `type${i % 10}`,
          source: `src${i % 100}`,
          target: `tgt${i % 100}`,
          weight: i % 5,
        });
      }

      const start = performance.now();
      const index = buildGraphIndex(edges);
      const mid = performance.now();
      for (let i = 0; i < 1000; i++) {
        queryGraphIndex(index, { type: 'type0', target: 'tgt0' });
      }
      const end = performance.now();

      const buildTime = mid - start;
      const queryTime = end - mid;

      assert.ok(buildTime < 100, `buildGraphIndex dauerte ${buildTime}ms, sollte < 100ms sein`);
      assert.ok(queryTime < 100, `1000x queryGraphIndex dauerte ${queryTime}ms, sollte < 100ms sein`);
    });
  });
});
