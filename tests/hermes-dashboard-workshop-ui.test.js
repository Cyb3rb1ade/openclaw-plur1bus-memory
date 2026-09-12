import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const bundle = readFileSync(new URL("../hermes-dashboard/plur1bus/dashboard/dist/index.js", import.meta.url), "utf8");

function harness() {
  const values = [], effects = [], requests = [];
  let cursor = 0, mounted = false, page;
  const proposal = { id: "11111111-1111-4111-8111-111111111111", revision: "a".repeat(64),
    skillName: "example", title: "Example", status: "published", activationPartial: true, evidence: [] };
  const React = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], value => { values[slot] = value; }];
    },
    useCallback: fn => fn,
    useEffect: fn => { if (!mounted) effects.push(fn); },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  };
  const SDK = { React, fetchJSON: async (url, options) => {
    requests.push({ url, options });
    if (options.method === "POST") return { published: true, activationPartial: true };
    if (url.endsWith("/status")) return { configured: true, agentId: "alpha" };
    if (url.endsWith("/workshop/proposals")) return { proposals: [proposal] };
    if (url.includes("/preview/")) return { review: proposal, nonce: "review-nonce" };
    if (url.includes("/workshop/proposals/")) return proposal;
    throw new Error("Unexpected request: " + url);
  } };
  vm.runInNewContext(bundle, { window: { __HERMES_PLUGIN_SDK__: SDK,
    __HERMES_PLUGINS__: { register: (name, component) => { assert.equal(name, "plur1bus"); page = component; } } } });
  function render() {
    cursor = 0;
    const tree = page();
    mounted = true;
    while (effects.length) effects.shift()();
    return tree;
  }
  function text(node) {
    return node && typeof node === "object" ? node.children.map(text).join(" ") : String(node ?? "");
  }
  function nodes(node) {
    return node && typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
  }
  function click(label) {
    const button = nodes(render()).find(node => node.type === "button" && text(node) === label);
    assert.ok(button, "Missing button: " + label);
    button.props.onClick();
  }
  render();
  return { render, text, click, requests };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("Hermes web workshop retains truthful partial-activation notice after refresh", async () => {
  const ui = harness();
  await settle();
  ui.click("Finish evidence confirmation");
  await settle();
  ui.click("Confirm publish");
  await settle();
  assert.match(ui.text(ui.render()), /evidence confirmation is still incomplete/i);
  const writes = ui.requests.filter(item => item.options.method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.headers["X-Plur1bus-Action-Nonce"], "review-nonce");
});

test("Hermes web workshop inspection never offers a mutation confirmation", async () => {
  const ui = harness();
  await settle();
  ui.click("View skill");
  await settle();
  assert.match(ui.text(ui.render()), /Mined skill/);
  assert.doesNotMatch(ui.text(ui.render()), /Confirm publish|Confirm approval/);
  assert.equal(ui.requests.filter(item => item.options.method === "POST").length, 0);
});
