#!/usr/bin/env node
/**
 * Measure synchronous recallStats.record for 20 UUIDs, including its connection
 * open/close and SQLite transaction. Run with Node 24; optional first argument
 * chooses a scratch parent directory on the filesystem to measure.
 * No embedding, LanceDB search, full recall, or contention is measured.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRecallStats } from '../engine/recall/recall-stats.js';

const root = mkdtempSync(join(resolve(process.argv[2] ?? tmpdir()), 'recall-stats-bench-'));
const ids = Array.from({ length: 20 }, (_, i) => `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`);
const results = [];
try {
  const stats = createRecallStats({ baseDbPath: root });
  for (const { name, samples, warmup, freshFile, distinct } of [
    { name: 'new-sidecar-first-write', samples: 100, warmup: 0, freshFile: true, distinct: false },
    { name: 'steady-repeat-query', samples: 500, warmup: 50, freshFile: false, distinct: false },
    { name: 'steady-distinct-query', samples: 500, warmup: 50, freshFile: false, distinct: true },
  ]) {
    const times = [];
    let lastAgent;
    for (let i = -warmup; i < samples; i++) {
      lastAgent = freshFile ? `first-${i}` : name;
      const query = distinct ? `synthetic query ${i}` : 'synthetic repeated query';
      const start = performance.now();
      stats.record(lastAgent, ids, query);
      const elapsed = performance.now() - start;
      if (i >= 0) times.push(elapsed);
    }
    // Validate actual commits, outside timed regions; never time a no-op path.
    const rows = stats.read(lastAgent, ids);
    assert.equal(rows.length, 20);
    for (const row of rows) {
      assert.equal(row.recalls, freshFile ? 1 : warmup + samples);
      assert.equal(row.distinctQueries, distinct ? warmup + samples : 1);
    }
    times.sort((a, b) => a - b);
    const rounded = n => Number(n.toFixed(3));
    const percentile = p => rounded(times[Math.ceil(p * times.length) - 1]);
    results.push({ name, samples, warmup, idsPerCall: 20,
      meanMs: rounded(times.reduce((a, b) => a + b, 0) / times.length),
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: rounded(times.at(-1)),
    });
  }
  console.log(JSON.stringify({ node: process.version, platform: platform(), release: release(),
    arch: process.arch, cpu: cpus()[0]?.model, scratchParent: resolve(process.argv[2] ?? tmpdir()), results,
    limits: 'Local uncontended synchronous record calls; every sample includes connection open, chmod, pragmas, schema checks, BEGIN IMMEDIATE, writes, COMMIT and close. First-write means a new SQLite sidecar, not cold OS/disk caches. Warmup does not retain SQLite handles. No cache flush, forced fsync beyond SQLite defaults, competing writers, slow/network filesystem, disk-pressure stress, or end-to-end recall measured. BEGIN IMMEDIATE can block up to the configured 5000ms busy timeout under contention.',
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
