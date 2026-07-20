import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_NAMESPACE,
  isLegacyReadOnly,
  resolveNamespaceLayout,
  resolveRecallReadNamespaces,
  resolveWriteNamespace,
} from "../lib/namespace-config.js";
import { ConfigContractError, PLUGIN_CONFIG_PATH } from "../lib/setup/config-contract.js";

const NS_PATH = `${PLUGIN_CONFIG_PATH}.namespaces`;

function assertNamespaceError(run, configPath, pattern = /invalid/i) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ConfigContractError);
    assert.equal(error.code, "INVALID_PLUGIN_CONFIG");
    assert.equal(error.configPath, configPath);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("namespace layout", () => {
  it("preserves the exact legacy-flat base path when namespace config is absent", () => {
    const layout = resolveNamespaceLayout("/db/custom", {
      activeWriteNamespace: "../not-interpreted",
    }, { explicit: false, path: NS_PATH });

    assert.deepEqual(layout, {
      mode: "legacy-flat",
      baseDir: "/db/custom",
      baseDbPath: "/db/custom",
      activeWriteNamespace: null,
      activeRecallNamespaces: [],
      legacyReadOnlyNamespaces: [],
      recallReadNamespaces: [],
      crossNamespaceRecall: false,
    });
    assert.equal(Object.isFrozen(layout), true);
    assert.equal(Object.isFrozen(layout.activeRecallNamespaces), true);
  });

  it("treats an active namespace leaf as an existing named-layout path", () => {
    const layout = resolveNamespaceLayout("/memory/ns-write", {
      activeWriteNamespace: "ns-write",
      activeRecallNamespaces: ["ns-write", "ns-read"],
      legacyReadOnlyNamespaces: ["ns-old"],
      crossNamespaceRecall: true,
    }, { explicit: true, path: NS_PATH });

    assert.deepEqual(layout, {
      mode: "named",
      baseDir: "/memory",
      baseDbPath: "/memory/ns-write",
      activeWriteNamespace: "ns-write",
      activeRecallNamespaces: ["ns-write", "ns-read"],
      legacyReadOnlyNamespaces: ["ns-old"],
      recallReadNamespaces: ["ns-write", "ns-read", "ns-old"],
      crossNamespaceRecall: true,
    });
  });

  it("treats an unmatched base path as the named root and applies semantic defaults", () => {
    const layout = resolveNamespaceLayout("/memory", {
      activeWriteNamespace: "ns-write",
    }, { explicit: true, path: NS_PATH });

    assert.equal(layout.baseDir, "/memory");
    assert.equal(layout.activeWriteNamespace, "ns-write");
    assert.deepEqual(layout.activeRecallNamespaces, ["ns-write"]);
    assert.deepEqual(layout.legacyReadOnlyNamespaces, []);
    assert.deepEqual(layout.recallReadNamespaces, ["ns-write"]);
    assert.equal(layout.crossNamespaceRecall, false);

    const defaults = resolveNamespaceLayout("/memory", {}, { explicit: true, path: NS_PATH });
    assert.equal(defaults.activeWriteNamespace, DEFAULT_NAMESPACE);
    assert.deepEqual(defaults.activeRecallNamespaces, [DEFAULT_NAMESPACE]);
  });

  it("rejects a base path ending in a configured non-writer namespace", () => {
    for (const [baseDbPath, config] of [
      ["/memory/ns-read", {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-write", "ns-read"],
      }],
      ["/memory/ns-old", {
        activeWriteNamespace: "ns-write",
        legacyReadOnlyNamespaces: ["ns-old"],
      }],
    ]) {
      assertNamespaceError(
        () => resolveNamespaceLayout(baseDbPath, config, { explicit: true, path: NS_PATH }),
        NS_PATH,
        /ambiguous/i,
      );
    }
  });

  it("rejects empty active recall, a missing writer, and active/legacy overlap", () => {
    assertNamespaceError(
      () => resolveNamespaceLayout("/memory", { activeRecallNamespaces: [] }, { explicit: true, path: NS_PATH }),
      `${NS_PATH}.activeRecallNamespaces`,
      /at least one|empty/i,
    );
    assertNamespaceError(
      () => resolveNamespaceLayout("/memory", {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-read"],
      }, { explicit: true, path: NS_PATH }),
      `${NS_PATH}.activeRecallNamespaces`,
      /writer|ns-write/i,
    );
    assertNamespaceError(
      () => resolveNamespaceLayout("/memory", {
        activeWriteNamespace: "ns-write",
        activeRecallNamespaces: ["ns-write", "ns-shared"],
        legacyReadOnlyNamespaces: ["ns-old", "ns-shared"],
      }, { explicit: true, path: NS_PATH }),
      `${NS_PATH}.legacyReadOnlyNamespaces[1]`,
      /active|read-only|overlap/i,
    );
  });

  it("rejects malicious writer identifiers without trimming or coercion", () => {
    for (const value of [
      "",
      ".",
      "..",
      "../escape",
      "bad/name",
      "bad\\name",
      "bad name",
      " /absolute",
      "/absolute",
      "a".repeat(65),
    ]) {
      assertNamespaceError(
        () => resolveNamespaceLayout("/memory", { activeWriteNamespace: value }, { explicit: true, path: NS_PATH }),
        `${NS_PATH}.activeWriteNamespace`,
        /identifier|pattern/i,
      );
    }
    assertNamespaceError(
      () => resolveNamespaceLayout("/memory", {
        activeRecallNamespaces: [DEFAULT_NAMESPACE, "bad/name"],
      }, { explicit: true, path: NS_PATH }),
      `${NS_PATH}.activeRecallNamespaces[1]`,
      /identifier|pattern/i,
    );
    assertNamespaceError(
      () => resolveNamespaceLayout("/memory", {
        legacyReadOnlyNamespaces: ["bad\\name"],
      }, { explicit: true, path: NS_PATH }),
      `${NS_PATH}.legacyReadOnlyNamespaces[0]`,
      /identifier|pattern/i,
    );
  });

  it("excludes legacy namespaces from recall unless cross-namespace recall is true", () => {
    const config = {
      activeWriteNamespace: "ns-write",
      activeRecallNamespaces: ["ns-write", "ns-read"],
      legacyReadOnlyNamespaces: ["ns-old"],
      crossNamespaceRecall: false,
    };
    const layout = resolveNamespaceLayout("/memory", config, { explicit: true, path: NS_PATH });

    assert.deepEqual(layout.activeRecallNamespaces, ["ns-write", "ns-read"]);
    assert.deepEqual(layout.legacyReadOnlyNamespaces, ["ns-old"]);
    assert.deepEqual(layout.recallReadNamespaces, ["ns-write", "ns-read"]);
  });

  it("collapses duplicates stably and deeply freezes private copies", () => {
    const config = {
      activeWriteNamespace: "ns-write",
      activeRecallNamespaces: ["ns-write", "ns-read", "ns-write", "ns-third", "ns-read"],
      legacyReadOnlyNamespaces: ["ns-old", "ns-older", "ns-old"],
      crossNamespaceRecall: true,
    };
    const layout = resolveNamespaceLayout("/memory", config, { explicit: true, path: NS_PATH });

    config.activeWriteNamespace = "mutated";
    config.activeRecallNamespaces[0] = "mutated";
    config.legacyReadOnlyNamespaces.push("mutated");
    assert.deepEqual(layout.activeRecallNamespaces, ["ns-write", "ns-read", "ns-third"]);
    assert.deepEqual(layout.legacyReadOnlyNamespaces, ["ns-old", "ns-older"]);
    assert.deepEqual(layout.recallReadNamespaces, ["ns-write", "ns-read", "ns-third", "ns-old", "ns-older"]);
    assert.equal(layout.activeWriteNamespace, "ns-write");
    assert.equal(Object.isFrozen(layout), true);
    assert.equal(Object.isFrozen(layout.activeRecallNamespaces), true);
    assert.equal(Object.isFrozen(layout.legacyReadOnlyNamespaces), true);
    assert.equal(Object.isFrozen(layout.recallReadNamespaces), true);
    assert.throws(() => layout.activeRecallNamespaces.push("late"), TypeError);
  });
});

describe("namespace compatibility wrappers", () => {
  it("uses the same semantic defaults and validation as named layouts", () => {
    assert.equal(resolveWriteNamespace({}), DEFAULT_NAMESPACE);
    assert.deepEqual(resolveRecallReadNamespaces({}), [DEFAULT_NAMESPACE]);

    const config = {
      activeWriteNamespace: "ns-write",
      activeRecallNamespaces: ["ns-write", "ns-write"],
      legacyReadOnlyNamespaces: ["ns-old", "ns-old"],
      crossNamespaceRecall: true,
    };
    assert.equal(resolveWriteNamespace(config), "ns-write");
    assert.deepEqual(resolveRecallReadNamespaces(config), ["ns-write", "ns-old"]);
    assert.equal(isLegacyReadOnly("ns-old", config), true);
    assert.equal(isLegacyReadOnly("ns-write", config), false);

    assertNamespaceError(
      () => resolveWriteNamespace({ activeWriteNamespace: "../escape" }),
      `${NS_PATH}.activeWriteNamespace`,
      /identifier|pattern/i,
    );
  });
});
