import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const state = { profile: 'alpha', connection: 'local' };
const values = {
  host: { state: { profile: { get: () => state.profile, subscribe: fn => { fn(); return () => {}; } },
    connectionId: { get: () => state.connection, subscribe: fn => { fn(); return () => {}; } } }, navigate() {} },
  useValue: () => undefined,
  STATUSBAR_AREAS: { left: 'statusBar.left' }, PALETTE_AREA: 'palette', SIDEBAR_NAV_AREA: 'sidebar.nav',
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
const { checkDesktopCompatibility } = plugin.namespace;
const compatibleHost = { openWorkspace() {}, profileRoutes: async () => [
  { connectionId: 'local', profile: 'alpha', targetProfile: 'alpha' }] };
let compatibilityCalls = [];
const compatibilityBridge = { api: async req => {
  compatibilityCalls.push(req);
  return { profile: 'alpha', profileBinding: 1, memoryProviderEnabled: true };
} };
const compatibility = await checkDesktopCompatibility(compatibleHost, compatibilityBridge, () => '["local","alpha"]');
assert.equal(compatibility.status, 'verified');
assert.equal(compatibility.sidebar, 'unknown', 'profile handshake does not prove host sidebar patch');
assert.equal(compatibilityCalls.length, 1);
assert.ok(compatibilityCalls[0].path.endsWith('/desktop/capabilities'));
assert.equal(compatibilityCalls[0].method, undefined, 'startup check is read-only');
assert.equal((await checkDesktopCompatibility({}, compatibilityBridge, () => '["local","alpha"]')).status, 'unsupported');
assert.equal(compatibilityCalls.length, 1, 'missing host API must not dispatch');
const mismatch = await checkDesktopCompatibility(compatibleHost, { api: async () => ({ profile: 'beta', profileBinding: 1 }) }, () => '["local","alpha"]');
assert.equal(mismatch.status, 'blocked');
assert.equal(mismatch.enabled, null);
const inactive = await checkDesktopCompatibility(compatibleHost, { api: async () => ({ profile: 'alpha', profileBinding: 1, memoryProviderEnabled: false }) }, () => '["local","alpha"]');
assert.equal(inactive.enabled, false);
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

let navOwner = 'local:enabled', navPending = [], visibilityStates = [];
const visibility = plugin.namespace.createNavigationVisibility(
  () => new Promise(resolve => navPending.push(resolve)), () => navOwner, value => visibilityStates.push(value));
const enabledProbe = visibility.refresh(); navPending.shift()(true); await enabledProbe;
assert.equal(visibilityStates.at(-1), true);
const staleProbe = visibility.refresh(); const staleReply = navPending.shift();
navOwner = 'local:disabled';
const disabledProbe = visibility.refresh();
assert.equal(visibilityStates.at(-1), false, 'profile switch cannot inherit the enabled menu');
navPending.shift()(false); await disabledProbe;
staleReply(true); await staleProbe;
assert.equal(visibilityStates.at(-1), false, 'late enabled result cannot resurrect a disabled profile menu');
navOwner = 'local:enabled';
const transient = visibility.refresh(); navPending.shift()(null); await transient;
assert.equal(visibilityStates.at(-1), true, 'transient failure keeps this profile last verified entry');
const deactivated = visibility.refresh(); navPending.shift()(false); await deactivated;
assert.equal(visibilityStates.at(-1), false, 'authoritative disable removes navigation');
visibility.dispose();

let contributions, opened = [], closed = 0;
const disposers = [];
globalThis.window = { location: { hash: '#/' }, addEventListener() {}, removeEventListener() {},
  hermesDesktop: { api: async () => ({ profileBinding: 1, profile: state.profile, memoryProviderEnabled: true }) } };
values.host.profileRoutes = async () => [{ connectionId: state.connection, profile: state.profile, targetProfile: state.profile }];
values.host.openWorkspace = (id, options) => { opened.push({ id, options }); return () => { closed++; }; };
plugin.namespace.default.register({ rest() {}, onDispose(fn) { disposers.push(fn); }, registerMany(value) { contributions = value; return () => {}; } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(plugin.namespace.default.id, 'plur1bus');
assert.equal(contributions.some(c => c.area === 'routes'), false, 'must not rely on the stale compiled route table');
const button = contributions.find(c => c.area === 'statusBar.left').data;
assert.equal(button.label, 'PLUR1BUS');
button.onSelect();
const sidebar = contributions.find(c => c.area === 'sidebar.nav').data;
assert.equal(sidebar.label, 'PLUR1BUS');
assert.equal(sidebar.path, undefined, 'sidebar must open workspace, not a stale route');
sidebar.onSelect();
assert.equal(contributions.find(c => c.area === 'palette').data.id, 'plur1bus.open');
contributions.find(c => c.area === 'palette').data.run();
assert.deepEqual(opened.map(c => c.id), ['plur1bus', 'plur1bus', 'plur1bus'], 'all entry points share the same workspace');
assert.equal(opened[0].options.title, 'PLUR1BUS');
disposers.forEach(dispose => dispose());
const inactiveDisposers = [], inactiveBatches = [];
globalThis.window.hermesDesktop.api = async () => ({ profileBinding: 1, profile: state.profile, memoryProviderEnabled: false });
plugin.namespace.default.register({ onDispose: fn => inactiveDisposers.push(fn),
  registerMany: batch => { inactiveBatches.push(batch); return () => {}; } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(inactiveBatches.flat().length, 1);
assert.equal(inactiveBatches.flat()[0].data.id, 'plur1bus.host-check', 'disabled profiles only retain diagnostics, not a memory button');
inactiveDisposers.forEach(dispose => dispose());

// Older hosts can omit the sidebar area entirely; status/palette still load.
const legacyNames = Object.keys(values).filter(name => name !== 'SIDEBAR_NAV_AREA');
const legacySdk = new vm.SyntheticModule(legacyNames, function () {
  for (const name of legacyNames) this.setExport(name, values[name]);
});
const legacy = new vm.SourceTextModule(await readFile(new URL('./plugin.js', import.meta.url), 'utf8'));
await legacy.link(name => name === 'react' ? react : legacySdk);
await legacy.evaluate();
globalThis.window.hermesDesktop.api = async () => ({ profileBinding: 1, profile: state.profile, memoryProviderEnabled: true });
const legacyBatches = [], legacyDisposers = [];
legacy.namespace.default.register({ onDispose: fn => legacyDisposers.push(fn),
  registerMany: batch => { legacyBatches.push(batch); return () => {}; } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(legacyBatches.flat().some(c => c.area === 'statusBar.left'));
assert.ok(legacyBatches.flat().some(c => c.data.id === 'plur1bus.open'));
assert.ok(!legacyBatches.flat().some(c => c.area === 'sidebar.nav' || !c.area));
legacyDisposers.forEach(dispose => dispose());
delete globalThis.window;
assert.equal(closed, 1, 'hot unload closes the owned workspace');
console.log('Native desktop routing, lifecycle, read and scoped action contracts passed.');
