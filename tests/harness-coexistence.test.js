/**
 * tests/harness-coexistence.test.js — HM4 plugin-side coexistence guards.
 *
 * Temporary directories plus injected env/platform. No test reads the real
 * home directory, a real Harness install, or a keychain.
 */

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  HARNESS_COEXISTENCE_NOTICE,
  STORE_INSIDE_HARNESS_HOME,
  StoreInsideHarnessHomeError,
  assertStoreOutsideHarnessHome,
  canonicalPath,
  findHarnessHome,
  inspectHarnessCoexistence,
  resolveHarnessHome,
  storeInsideHarnessHome,
  warnIfStoreInsideHarnessHome,
} from "../lib/setup/harness-coexistence.js";
import { formatSelftestReport } from "../lib/setup/selftest-plugin-runtime.js";
import { SELFTEST_STEPS } from "../lib/selftest/run-selftest.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function box() {
  const root = makeTempDir("hm4-");
  const homedir = join(root, "home");
  mkdirSync(homedir);
  return { root, homedir };
}

function installHarness(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{}\n");
  return dir;
}

describe("resolveHarnessHome", () => {
  it("uses PLUR1BUS_HOME when set, including as an env override of the default", () => {
    const { homedir } = box();
    const custom = join(homedir, "custom-home");
    assert.equal(
      resolveHarnessHome({ env: { PLUR1BUS_HOME: custom }, platform: "linux", homedir }),
      custom,
    );
    assert.equal(
      resolveHarnessHome({ env: { PLUR1BUS_HOME: custom }, platform: "darwin", homedir }),
      custom,
    );
  });

  it("treats empty PLUR1BUS_HOME as unset", () => {
    const { homedir } = box();
    assert.equal(
      resolveHarnessHome({ env: { PLUR1BUS_HOME: "" }, platform: "linux", homedir }),
      join(homedir, ".plur1bus"),
    );
    assert.equal(
      resolveHarnessHome({ env: { PLUR1BUS_HOME: "   " }, platform: "linux", homedir }),
      join(homedir, ".plur1bus"),
    );
  });

  it("defaults to <homedir>/.plur1bus on linux and darwin", () => {
    const { homedir } = box();
    assert.equal(resolveHarnessHome({ env: {}, platform: "linux", homedir }), join(homedir, ".plur1bus"));
    assert.equal(resolveHarnessHome({ env: {}, platform: "darwin", homedir }), join(homedir, ".plur1bus"));
  });

  it("defaults to %LOCALAPPDATA%/PLUR1BUS on win32", () => {
    const { homedir } = box();
    const lad = join(homedir, "AppData", "Local");
    assert.equal(
      resolveHarnessHome({ env: { LOCALAPPDATA: lad }, platform: "win32", homedir }),
      join(lad, "PLUR1BUS"),
    );
    assert.equal(
      resolveHarnessHome({ env: {}, platform: "win32", homedir }),
      join(homedir, "AppData", "Local", "PLUR1BUS"),
    );
    assert.equal(
      resolveHarnessHome({ env: { localappdata: lad }, platform: "win32", homedir }),
      join(lad, "PLUR1BUS"),
    );
  });

  it("accepts home as the Harness --home slot (plugin has no CLI --home)", () => {
    const { homedir } = box();
    const explicit = join(homedir, "explicit");
    assert.equal(
      resolveHarnessHome({ home: explicit, env: { PLUR1BUS_HOME: join(homedir, "ignored") }, platform: "linux", homedir }),
      explicit,
    );
  });
});

describe("findHarnessHome", () => {
  it("requires HB9 manifest.json at the resolved home, not a config.json-only directory", () => {
    const { homedir } = box();
    const home = join(homedir, ".plur1bus");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), "{}\n");
    assert.equal(findHarnessHome({ env: {}, platform: "linux", homedir }), null);
    installHarness(home);
    assert.equal(findHarnessHome({ env: {}, platform: "linux", homedir }), canonicalPath(home));
  });

  it("does not walk ancestors for a generic manifest.json", () => {
    const { root, homedir } = box();
    const npmPkg = join(root, "node_modules", "some-pkg");
    installHarness(npmPkg);
    const store = join(npmPkg, "lancedb");
    const result = inspectHarnessCoexistence({
      storePath: store,
      env: { PLUR1BUS_HOME: join(root, "not-the-harness") },
      platform: "linux",
      homedir,
    });
    assert.equal(result.harnessHome, null);
    assert.equal(result.violation, false);
  });

  it("counts only the active resolved home, not a leftover default", () => {
    const { homedir } = box();
    const fallback = installHarness(join(homedir, ".plur1bus"));
    const override = join(homedir, "override");
    mkdirSync(override);
    assert.equal(
      findHarnessHome({ env: { PLUR1BUS_HOME: override }, platform: "linux", homedir }),
      null,
      "override without marker is not a harness, even if ~/.plur1bus has one",
    );
    installHarness(override);
    assert.equal(
      findHarnessHome({ env: { PLUR1BUS_HOME: override }, platform: "linux", homedir }),
      canonicalPath(override),
    );
    assert.notEqual(
      findHarnessHome({ env: { PLUR1BUS_HOME: override }, platform: "linux", homedir }),
      canonicalPath(fallback),
    );
  });
});

describe("storeInsideHarnessHome", () => {
  it("refuses a store in, below, and via a symlink into a harness home; allows a sibling", () => {
    const { root, homedir } = box();
    const home = installHarness(join(root, "harness"));
    const env = { PLUR1BUS_HOME: home };
    const platform = "linux";

    const direct = inspectHarnessCoexistence({ storePath: home, env, platform, homedir });
    assert.equal(direct.violation, true);
    assert.equal(direct.error.code, STORE_INSIDE_HARNESS_HOME);
    assert.equal(direct.error.storePath, canonicalPath(home));
    assert.equal(direct.error.harnessHome, canonicalPath(home));
    assert.match(direct.error.message, /choose a path outside the Harness home, or use the Harness as the memory \(import\)/);

    const below = inspectHarnessCoexistence({ storePath: join(home, "nested", "lancedb"), env, platform, homedir });
    assert.equal(below.violation, true);

    const sibling = inspectHarnessCoexistence({ storePath: join(root, "sibling-store"), env, platform, homedir });
    assert.equal(sibling.violation, false);
    assert.equal(sibling.harnessHome, canonicalPath(home));
    assert.equal(sibling.notice, HARNESS_COEXISTENCE_NOTICE);

    const prefixTrap = inspectHarnessCoexistence({ storePath: join(root, "harness-extra", "lancedb"), env, platform, homedir });
    assert.equal(prefixTrap.violation, false);

    let linked = false;
    const link = join(root, "link-into-home");
    try {
      symlinkSync(home, link);
      linked = true;
    } catch {
      // Directory symlinks need an extra privilege on some Windows runners.
    }
    if (linked) {
      const viaLink = inspectHarnessCoexistence({ storePath: join(link, "lancedb"), env, platform, homedir });
      assert.equal(viaLink.violation, true, "symlink into the harness home is refused");
      assert.equal(storeInsideHarnessHome(join(link, "lancedb"), home, platform), true);
    }
  });

  it("refuses a case-different spelling on win32 and darwin, not on linux", () => {
    const store = "/tmp/HarnessHome/lancedb";
    const home = "/tmp/harnesshome";
    assert.equal(storeInsideHarnessHome(store, home, "win32"), true);
    assert.equal(storeInsideHarnessHome(store, home, "darwin"), true);
    assert.equal(storeInsideHarnessHome(store, home, "linux"), false);
  });

  it("has no notice when no harness is found", () => {
    const { homedir } = box();
    const result = inspectHarnessCoexistence({
      storePath: join(homedir, "store"),
      env: {},
      platform: "linux",
      homedir,
    });
    assert.equal(result.harnessHome, null);
    assert.equal(result.notice, null);
    assert.equal(result.violation, false);
  });
});

describe("assertStoreOutsideHarnessHome", () => {
  it("throws the typed error for a store inside the home and returns for a sibling", () => {
    const { root, homedir } = box();
    const home = installHarness(join(root, "harness"));
    const env = { PLUR1BUS_HOME: home };
    assert.throws(
      () => assertStoreOutsideHarnessHome(join(home, "lancedb"), { env, platform: "linux", homedir }),
      (error) => error instanceof StoreInsideHarnessHomeError && error.code === STORE_INSIDE_HARNESS_HOME,
    );
    const ok = assertStoreOutsideHarnessHome(join(root, "outside"), { env, platform: "linux", homedir });
    assert.equal(ok.violation, false);
    assert.equal(ok.notice, HARNESS_COEXISTENCE_NOTICE);
  });
});

describe("warnIfStoreInsideHarnessHome", () => {
  it("warns and does not throw when the store is inside the harness home", () => {
    const { root, homedir } = box();
    const home = installHarness(join(root, "harness"));
    const warnings = [];
    const result = warnIfStoreInsideHarnessHome({
      storePath: join(home, "lancedb"),
      env: { PLUR1BUS_HOME: home },
      platform: "linux",
      homedir,
      logger: { warn: (message) => warnings.push(message) },
    });
    assert.equal(result.violation, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /store path /);
    assert.match(warnings[0], /harness home /);
  });
});

describe("formatSelftestReport coexistence notice", () => {
  function report(ok, overrides = {}) {
    return {
      ok,
      addons: [],
      steps: SELFTEST_STEPS.map((id) => (id === "coexistence" ? { id, ok, ms: 0 } : { id, ok: true, ms: 1 })),
      harnessHome: null,
      errors: ok ? [] : [STORE_INSIDE_HARNESS_HOME],
      ...overrides,
    };
  }

  it("prints the info line with a synthetic harness home and omits it without one", () => {
    const withHome = formatSelftestReport(report(true, { harnessHome: join(box().root, "synthetic-harness") }));
    const info = withHome.split("\n").filter((line) => line.startsWith("info"));
    assert.equal(info.length, 1);
    assert.equal(info[0], `info    ${HARNESS_COEXISTENCE_NOTICE}`);

    const without = formatSelftestReport(report(true, { harnessHome: null }));
    assert.equal(without.split("\n").some((line) => line.startsWith("info")), false);
  });
});
