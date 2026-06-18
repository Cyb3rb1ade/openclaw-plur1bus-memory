import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRecallReadNamespaces,
  resolveWriteNamespace,
  isLegacyReadOnly,
  DEFAULT_NAMESPACE,
} from "../lib/namespace-config.js";

describe("namespace-config", () => {
  const defaultCfg = {};

  it("ohne Namespace-Config: Recall liest [DEFAULT_NAMESPACE]", () => {
    const ns = resolveRecallReadNamespaces(defaultCfg);
    assert.deepStrictEqual(ns, [DEFAULT_NAMESPACE]);
  });

  it("ohne Namespace-Config: Write-Namespace ist DEFAULT_NAMESPACE", () => {
    assert.strictEqual(resolveWriteNamespace(defaultCfg), DEFAULT_NAMESPACE);
  });

  it("activeWriteNamespace wird nur zum Schreiben genutzt", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
    };
    assert.strictEqual(resolveWriteNamespace(cfg), "lancedb-local");
  });

  it("crossNamespaceRecall=true: Recall liest activeRecall + legacyReadOnly", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
      crossNamespaceRecall: true,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.ok(ns.includes("lancedb-local"), "activeRecallNamespaces fehlt");
    assert.ok(ns.includes("lancedb-namespaced"), "legacyReadOnlyNamespaces fehlt");
    assert.strictEqual(ns.length, 2);
  });

  it("crossNamespaceRecall=false: Recall liest nur activeRecallNamespaces", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
      crossNamespaceRecall: false,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.deepStrictEqual(ns, ["lancedb-local"]);
  });

  it("legacyReadOnlyNamespace darf nicht write-Namespace sein", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
    };
    assert.ok(
      !isLegacyReadOnly(resolveWriteNamespace(cfg), cfg),
      "Write-Namespace darf nicht read-only sein"
    );
    assert.ok(isLegacyReadOnly("lancedb-namespaced", cfg));
  });

  it("keine Duplikate in recallReadNamespaces", () => {
    const cfg = {
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-local"], // absichtlich doppelt
      crossNamespaceRecall: true,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.strictEqual(ns.length, new Set(ns).size, "Duplikate in recallReadNamespaces");
  });
});
