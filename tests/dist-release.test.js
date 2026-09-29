// tests/dist-release.test.js — HM1 Task 10: version consistency, the release workflow's static contract, the release notes.
// Local only: reads repository files, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(REPO, ".github", "workflows", "plugin-release.yml");
const readJson = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

describe("plugin release (HM1 Task 10)", () => {
  it("package.json, openclaw.plugin.json and the lockfile agree on the version", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    const manifest = readJson("openclaw.plugin.json");
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version, pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(pkg.version, "7.17.0", "HM1 ships as 7.17.0 (HM1-R19)");
  });

  it("plugin-release.yml parses and pins every action to a SHA", () => {
    const text = readFileSync(WORKFLOW, "utf8");
    const wf = parseYaml(text);
    assert.deepEqual(wf.on.push.tags, ["v*"]);
    assert.equal(wf.on.workflow_dispatch.inputs["dry-run"].default, true);
    assert.equal(wf.on.workflow_dispatch.inputs.channel.default, "stable");
    assert.deepEqual(wf.permissions, { contents: "read" });
    const uses = [];
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "uses") uses.push(v);
          walk(v);
        }
      }
    };
    walk(wf.jobs);
    assert.ok(uses.length >= 6, `found ${uses.length} uses:`);
    for (const u of uses) {
      if (u.startsWith("./")) assert.equal(u, "./.github/workflows/plugin-dist.yml");
      else assert.match(u, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/, u);
    }
    for (const line of text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l) && !l.includes("./.github/"))) {
      assert.match(line, /@[0-9a-f]{40} # v\d/, `pinned with a version comment: ${line.trim()}`);
    }
    // No secret is referenced: only the automatic token; npm publishes through OIDC trusted publishing.
    assert.equal([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].length, 0, "no secrets.* reference");
    assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN/.test(text.replace(/^\s*#.*$/gm, "")), "no npm token");
    assert.ok(!/minisign\s+-S|\.key\b/.test(text.replace(/^\s*#.*$/gm, "")), "the feed is never signed in CI");
  });

  it("plugin-release.yml grants id-token and attestations only where needed", () => {
    const wf = parseYaml(readFileSync(WORKFLOW, "utf8"));
    assert.deepEqual(Object.keys(wf.jobs), ["check", "dist", "assemble", "github-release", "npm-publish"]);
    assert.equal(wf.jobs.dist.uses, "./.github/workflows/plugin-dist.yml");
    for (const [name, job] of Object.entries(wf.jobs)) {
      const p = job.permissions ?? {};
      if (name === "assemble") assert.deepEqual(p, { contents: "read", "id-token": "write", attestations: "write" });
      else if (name === "github-release") assert.deepEqual(p, { contents: "write" });
      else if (name === "npm-publish") assert.deepEqual(p, { contents: "read", "id-token": "write" });
      else assert.ok(!("id-token" in p) && !("attestations" in p), `${name} needs neither`);
    }
    assert.equal(wf.jobs["npm-publish"].environment, "npm-publish");
  });

  it("the release notes exist in de and en for the package version", () => {
    const { version } = readJson("package.json");
    for (const lang of ["de", "en"]) {
      const file = join(REPO, "docs", "release-notes", `${version}.${lang}.md`);
      assert.ok(existsSync(file), `${file} exists`);
      const text = readFileSync(file, "utf8");
      assert.ok(text.length <= 1500, `${lang} notes are ${text.length} characters (max 1500)`);
      assert.equal((text.match(/^## .+$/gm) ?? []).length, 3, `${lang}: three fixed headings`);
    }
    const en = readFileSync(join(REPO, "docs", "release-notes", `${version}.en.md`), "utf8");
    for (const h of ["What's new", "Fixes", "Upgrade notes"]) assert.ok(en.includes(`## ${h}\n`), h);
    const de = readFileSync(join(REPO, "docs", "release-notes", `${version}.de.md`), "utf8");
    for (const h of ["Neu", "Korrekturen", "Hinweise zum Upgrade"]) assert.ok(de.includes(`## ${h}\n`), h);
  });
});
