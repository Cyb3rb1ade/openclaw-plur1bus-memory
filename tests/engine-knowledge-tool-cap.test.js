import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../engine/create-engine.js';
import { internalsOf } from '../engine/internals.js';
import { trackKnowledgePending, readKnowledgePendingSnapshot } from '../engine/knowledge/knowledge-pending.js';
import { config, flatEmbedder, seedAndGetId, twoWorkspaceHost } from './helpers/shared-workspace-engine.js';
import { makeTempDir } from './helpers/temp-dir.js';

// A missing key must retain the legacy tool's rolling-window limit; using `|| 3`
// instead of `?? 3` must also fail, because explicit zero means unlimited.
for (const { name, schicht15, integrated, remaining } of [
  { name: 'omitted cap keeps the legacy three-card rolling 24-hour tool limit', schicht15: { enabled: true }, integrated: 3, remaining: 2 },
  { name: 'explicit zero lets the tool integrate all five cards', schicht15: { enabled: true, maxPromotionsPerRun: 0 }, integrated: 5, remaining: 0 },
]) {
  it(name, { timeout: 90_000 }, async (t) => {
    const { host, workspaceDir } = twoWorkspaceHost(makeTempDir('tool-cap-state-'));
    host.runtime = { llm: { complete: async ({ purpose }) => ({
      text: purpose === 'knowledge-update' ? '# Knowledge\n\nThe lighthouse decisions are durable.' : '{"importance":0.9,"intensity":0,"dominant":"neutral","emotions":{}}',
      provider: 'fixture', model: 'fixture',
    }) } };
    const engine = createEngine(host, { ...config(makeTempDir('tool-cap-db-')), schicht15 }, { internals: { embeddings: flatEmbedder() } });
    t.after(() => engine.close({ budgetMs: 5_000 }));
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedAndGetId(engine, 'anna', `Lighthouse ${i} tool promotion decision is final.`, 'lighthouse');
      ids.push(id);
      trackKnowledgePending(workspaceDir, { sourceAgent: 'anna', memoryId: id });
    }
    await engine.jobs.run('emotion-refine', 'anna');
    const tool = internalsOf(engine).getToolFactory()({ agentId: 'anna', workspaceDir }).find(item => item.name === 'knowledge_update');
    const first = await tool.execute('cap-first', {});
    assert.match(first.content[0].text, new RegExp(`${integrated} memories integrated`));
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, remaining);
    const path = join(workspaceDir, 'memory', 'KNOWLEDGE.md');
    const body = readFileSync(path, 'utf8');
    for (const id of ids.slice(0, integrated)) assert.ok(body.includes(id));
    for (const id of ids.slice(integrated)) assert.ok(!body.includes(id));
    const second = await tool.execute('cap-second', {});
    assert.match(second.content[0].text, remaining ? /promotion limit reached \(3\/3\)/ : /No pending memories/);
    assert.equal(readKnowledgePendingSnapshot(workspaceDir).pending.length, remaining);
    assert.equal(readFileSync(path, 'utf8'), body);
  });
}
