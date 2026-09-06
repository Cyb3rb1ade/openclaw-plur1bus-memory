import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const state = { profile: 'alpha', connection: 'local' };
const values = {
  host: { state: { profile: { get: () => state.profile }, connectionId: { get: () => state.connection } }, navigate() {} },
  useValue: () => undefined,
  STATUSBAR_AREAS: { left: 'statusBar.left' }, PALETTE_AREA: 'palette',
};
const sdk = new vm.SyntheticModule(Object.keys(values), function () {
  for (const [key, value] of Object.entries(values)) this.setExport(key, value);
});
const react = new vm.SyntheticModule(['default'], function () {
  this.setExport('default', { createElement: (...args) => args });
});
// Execute the actual distributed ESM, with only its documented host imports injected.
const plugin = new vm.SourceTextModule(await readFile(new URL('./plugin.js', import.meta.url), 'utf8'));
await plugin.link(name => {
  if (name === 'react') return react;
  if (name === '@hermes/plugin-sdk') return sdk;
  throw new Error(`Unexpected external import: ${name}`);
});
await plugin.evaluate();
const { createScopedReader } = plugin.namespace;
const { createScopedRequest } = plugin.namespace;
const { createProfileTransport } = plugin.namespace;
const { retrievalDefaults } = plugin.namespace;
assert.equal(retrievalDefaults('local-onnx', 'embedding').licenseAccepted, false);
assert.equal(retrievalDefaults('local-onnx', 'embedding').dimensions, 768);
assert.deepEqual(retrievalDefaults('disabled', 'reranker'), { provider: 'disabled' });
assert.equal(retrievalDefaults('local-transformers', 'embedding').localFilesOnly, true);
assert.equal(retrievalDefaults('openai-compatible', 'embedding').model, '');
assert.equal(retrievalDefaults('openai-compatible', 'embedding').apiKey, undefined);

// The ambient SDK transport can lag the visible profile. Pin Electron routing
// explicitly and require the backend's profile-binding protocol before any data.
let selected = 'local:bernhardine', wire = [], resolveWire;
const pinned = createProfileTransport(async request => {
  wire.push(request);
  assert.equal(request.connectionId, 'local');
  assert.equal(request.profile, 'bernhardine');
  assert.equal(new URL(request.path, 'http://test').searchParams.get('expectedProfile'),
    request.path.includes('/desktop/capabilities') ? null : 'bernhardine');
  return request.path.includes('/desktop/capabilities')
    ? { profileBinding: 1, profile: 'bernhardine' } : { agentId: 'bernhardine' };
}, async () => [{ connectionId: 'local', profile: 'bernhardine', targetProfile: 'bernhardine' }],
{ connection: 'local', profile: 'bernhardine' }, () => selected, selected);
assert.equal((await pinned('/status')).agentId, 'bernhardine');
assert.equal(wire.length, 2);
assert.match(wire[0].path, /desktop\/capabilities/);
selected = 'local:bernd';
await assert.rejects(pinned('/desktop/workshop/approve', { method: 'POST' }));
assert.equal(wire.length, 2, 'changed profile must not dispatch a stale write');
selected = 'local:bernhardine';
for (const response of [{}, { profileBinding: 1, profile: 'default' }]) {
  let calls = 0;
  const wrong = createProfileTransport(async () => { calls++; return response; }, async () => [
    { connectionId: 'local', profile: 'bernhardine', targetProfile: 'bernhardine' },
  ], { connection: 'local', profile: 'bernhardine' }, () => selected, selected);
  await assert.rejects(wrong('/memories'));
  assert.equal(calls, 1, 'unverified backend must never receive memory/action requests');
}
const racing = createProfileTransport(async () => { throw Error('must not dispatch'); },
  () => new Promise(resolve => { resolveWire = resolve; }),
  { connection: 'local', profile: 'bernhardine' }, () => selected, selected);
const race = racing('/status');
selected = 'elsewhere:bernhardine';
resolveWire([{ connectionId: 'local', profile: 'bernhardine', targetProfile: 'bernhardine' }]);
await assert.rejects(race);

let dispatches = 0, finish;
let identity = 'local:alpha';
const requests = createScopedRequest((path, options) => {
  dispatches++;
  assert.equal(path, '/desktop/workshop/approve');
  assert.equal(options.method, 'POST');
  assert.equal(options.body.nonce, 'reviewed-once');
  assert.equal(options.timeoutMs, 10000);
  return new Promise(resolve => { finish = resolve; });
}, () => identity);
const action = requests.run('/desktop/workshop/approve', { method: 'POST', body: { nonce: 'reviewed-once' } });
identity = 'remote:alpha';
finish({ ok: true });
assert.deepEqual(await action, { stale: true }, 'connection switch must discard action result');
assert.deepEqual(await requests.run('/desktop/workshop/approve'), { stale: true });
assert.equal(dispatches, 1, 'stale action must not dispatch to another connection');
requests.dispose();
identity = 'local:alpha';
await requests.run('/desktop/workshop/approve');
assert.equal(dispatches, 1, 'disposed action must not dispatch');
const failed = createScopedRequest(() => { throw Error('secret'); }, () => 'owner');
assert.deepEqual(await failed.run('/memories'), { error: true });

let scope = 'alpha', pending = [], published = [];
const reader = createScopedReader((path, options) => {
  assert.equal(options.timeoutMs, 10000);
  assert.ok(['/status', '/workshop/proposals'].includes(path));
  assert.equal(options.method, undefined); // read-only; no mutation door
  return new Promise(resolve => pending.push(resolve));
}, () => scope, value => published.push(value));
const old = reader.load();
await Promise.resolve();
scope = 'beta';
pending.splice(0).forEach(resolve => resolve({ agentId: 'alpha' }));
await old;
assert.equal(published.length, 1, 'foreign profile result must not publish');

const earlier = reader.load(); await Promise.resolve();
const previous = pending.splice(0);
const latest = reader.load(); await Promise.resolve();
pending.splice(0).forEach(resolve => resolve({ agentId: 'beta', proposals: [] }));
await latest;
previous.forEach(resolve => resolve({ agentId: 'stale' })); await earlier;
assert.equal(published.at(-1).status.agentId, 'beta', 'stale refresh must not replace fresh data');
const last = reader.load(); await Promise.resolve(); reader.dispose();
const before = published.length;
pending.splice(0).forEach(resolve => resolve({})); await last;
assert.equal(published.length, before, 'disposed view must not publish');

let result;
const degraded = createScopedReader(path => path === '/status'
  ? Promise.resolve({ agentId: 'healthy' }) : Promise.reject(new Error('private endpoint path')),
() => 'alpha', value => { result = value; });
await degraded.load();
assert.equal(result.status.agentId, 'healthy');
assert.ok(result.workshopError);
assert.ok(!JSON.stringify(result).includes('private endpoint path'));

let contributions, dispose, opened = [], closed = 0;
values.host.openWorkspace = (id, options) => { opened.push({ id, options }); return () => { closed++; }; };
plugin.namespace.default.register({ rest() {}, onDispose(fn) { dispose = fn; }, registerMany(value) { contributions = value; } });
assert.equal(plugin.namespace.default.id, 'plur1bus');
assert.equal(contributions.some(c => c.area === 'routes'), false, 'must not rely on the stale compiled route table');
const button = contributions.find(c => c.area === 'statusBar.left').data;
assert.equal(button.label, 'PLUR1BUS');
button.onSelect();
assert.equal(contributions.find(c => c.area === 'palette').data.id, 'plur1bus.open');
contributions.find(c => c.area === 'palette').data.run();
assert.deepEqual(opened.map(c => c.id), ['plur1bus', 'plur1bus'], 'stable workspace ID prevents duplicate tabs');
assert.equal(opened[0].options.title, 'PLUR1BUS');
dispose();
assert.equal(closed, 1, 'hot unload closes the owned workspace');
console.log('Native desktop routing, lifecycle, read and scoped action contracts passed.');
