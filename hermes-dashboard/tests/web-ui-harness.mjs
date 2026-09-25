/** Render the distributed web component with injected host hooks, without production state. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let component, cursor, data;
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) {
    const slot = cursor++;
    return [slot === 0 ? data : slot === 3 ? false : initial, () => {}];
  },
  useEffect() {}, useCallback: fn => fn,
};
const context = vm.createContext({ window: {
  __HERMES_PLUGIN_SDK__: { React, fetchJSON: () => { throw Error('render must not dispatch'); } },
  __HERMES_PLUGINS__: { register(name, page) { assert.equal(name, 'plur1bus'); component = page; } },
} });
vm.runInContext(await readFile(new URL('../plur1bus/dashboard/dist/index.js', import.meta.url), 'utf8'), context);
function render(count, scopeType = 'agent-private', version) {
  cursor = 0;
  data = { agentId: 'Coder', scopeType, version, storage: {}, cards: { byPrimaryAgent: [
    { id: 'Coder', profile: 'Coder', cards: count }, { id: 'foreign', profile: 'secret-profile', cards: 999 },
  ] } };
  return component();
}
function text(tree) {
  if (tree == null || tree === false) return '';
  if (typeof tree !== 'object') return String(tree);
  return (Array.isArray(tree) ? tree : tree.children || []).map(text).join(' | ');
}
for (const count of [0, 4, null, -1, '99']) {
  const tree = render(count);
  const panel = tree.children.find(node => text(node).includes('Cards by primary agent'));
  const rendered = text(panel);
  assert.match(rendered, /active profile/);
  assert.match(rendered, /Coder/);
  assert.doesNotMatch(rendered, /secret-profile|999|foreign/);
  assert.ok(rendered.includes(`Cards | ${Number.isSafeInteger(count) && count >= 0 ? count : 'Not available'}`));
  assert.match(text(tree), /Skill Workshop/, 'existing Workshop remains rendered');
}
assert.match(text(render(4, 'chat')), /No private primary-agent count available/);
assert.match(text(render(4)), /Version unavailable/);
assert.match(text(render(4, 'agent-private', '7.15.4')), /PLUR1BUS 7.15.4/);
assert.equal(render(4, 'agent-private', '7.15.4').children.at(-1).type, 'footer');
const settingsNode = render(4).children.find(node => typeof node?.type === 'function' && node.type.name === 'SettingsPanel');
cursor = 0;
data = { settings: [{ id: 'autoCapture', label: 'Automatisch speichern', group: 'Speicherung', value: true, choices: [true, false] }] };
const settingsTree = settingsNode.type();
assert.match(text(settingsTree), /Speicherung.*Automatisch speichern.*Enabled.*Disabled/);
cursor = 0;
data = { settings: [{ id: 'recall.maxPromptMemories', label: 'Erinnerungen im Prompt', group: 'Recall',
  value: 12, minimum: 5, maximum: 100, description: 'Begrenzt den Prompt.' }] };
const numericTree = settingsNode.type();
function elements(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === type ? [tree] : []), ...(Array.isArray(tree) ? tree : tree.children || []).flatMap(child => elements(child, type))];
}
const slider = elements(numericTree, 'input')[0];
assert.equal(slider.props.type, 'range');
assert.equal(slider.props.value, 12);
assert.equal(slider.props['aria-describedby'], 'pb-help-recall.maxPromptMemories');
assert.equal(text(elements(numericTree, 'output')[0]), '12');
console.log('Distributed web UI renders scoped primary-agent counts, unknowns and retained Workshop.');
