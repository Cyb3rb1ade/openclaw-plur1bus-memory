// tests/dist-release.test.js — HM1 Task 10: version consistency, the release workflow's static contract, the release notes.
// Local only: reads repository files, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { renderBootstraps, renderInstallerKeys } from "../scripts/dist/render-bootstraps.mjs";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(REPO, ".github", "workflows", "plugin-release.yml");
const text = readFileSync(WORKFLOW, "utf8");
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
    const wf = parseYaml(text);
    assert.deepEqual(Object.keys(wf.jobs), ["check", "dist", "assemble", "attest", "github-release", "npm-publish"]);
    assert.equal(wf.jobs.dist.uses, "./.github/workflows/plugin-dist.yml");
    for (const [name, job] of Object.entries(wf.jobs)) {
      const p = job.permissions ?? {};
      if (name === "assemble") assert.deepEqual(p, { contents: "read" });
      else if (name === "attest") assert.deepEqual(p, { contents: "read", "id-token": "write", attestations: "write" });
      else if (name === "github-release") assert.deepEqual(p, { contents: "write" });
      else if (name === "npm-publish") assert.deepEqual(p, { contents: "read", "id-token": "write" });
      else assert.ok(!("id-token" in p) && !("attestations" in p), `${name} needs neither`);
    }
    assert.equal(wf.jobs["npm-publish"].environment, "npm-publish");
    // attestations are real-run only and follow assemble; the release waits for them
    assert.match(wf.jobs.attest.if, /dry-run != 'true'/);
    assert.ok(wf.jobs.attest.needs.includes("assemble") && wf.jobs["github-release"].needs.includes("attest"));
    // the npm decision is made once, in assemble
    assert.equal(wf.jobs["npm-publish"].if.includes("vars."), false);
    assert.match(wf.jobs["npm-publish"].if, /needs\.assemble\.outputs\.npm == 'yes'/);
    assert.equal((text.match(/vars\.PLUR1BUS_NPM_PUBLISH/g) ?? []).length, 1);
  });

  it("plugin-release.yml: dist-tag per channel, credentials not persisted, SHA256SUMS as published, tarball re-checked", () => {
    const wf = parseYaml(text);
    const publish = wf.jobs["npm-publish"].steps.find((s) => /npm publish/.test(s.run ?? "")).run;
    assert.match(publish, /stable\) dist_tag=latest/);
    assert.match(publish, /beta\) dist_tag=beta/);
    assert.match(publish, /npm publish "\.\/\$TGZ" --provenance --access public --tag "\$dist_tag"/);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (String(step.uses).startsWith("actions/checkout@")) assert.equal(step.with?.["persist-credentials"], false, `${name}: checkout`);
      }
    }
    const sums = wf.jobs.assemble.steps.find((s) => s.name === "Write SHA256SUMS").run;
    assert.match(sums, /"plugin-\$CHANNEL\.unsigned\.json" > SHA256SUMS/);
    assert.ok(!/"plugin-\$CHANNEL\.json" > SHA256SUMS/.test(sums));
    const stage = wf.jobs.assemble.steps.find((s) => s.name === "Stage the release files").run;
    assert.match(stage, /differs from pack\.json/);
    assert.match(stage, /p\.sha256/);
    assert.match(stage, /p\.integrity/);
  });

  it("every checkout in every workflow sets persist-credentials: false", () => {
    const dir = join(REPO, ".github", "workflows");
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    for (const want of ["ci.yml", "plugin-release.yml", "plugin-dist.yml"]) assert.ok(files.includes(want), want);
    let n = 0;
    for (const file of files) {
      const wf = parseYaml(readFileSync(join(dir, file), "utf8"));
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!String(step.uses).startsWith("actions/checkout@")) continue;
          n += 1;
          assert.equal(step.with?.["persist-credentials"], false, `${file} ${name}: checkout`);
        }
      }
    }
    assert.ok(n >= 14, `found ${n} checkouts`);
  });

  it("assemble renders the channel keys into the installer bundle before the feed and SHA256SUMS (HM1-R-F1)", () => {
    const wf = parseYaml(text);
    const steps = wf.jobs.assemble.steps;
    const idx = (pred) => steps.findIndex(pred);
    const render = idx((s) => /render-bootstraps\.mjs/.test(s.run ?? ""));
    assert.ok(render >= 0, "a render step");
    const run = steps[render].run;
    assert.match(run, /bundle="\$out\/plur1bus-plugin-installer\.mjs"/);
    const calls = run.split("\n").filter((l) => /render-bootstraps\.mjs/.test(l));
    assert.equal(calls.length, 2, "release keys and dry-run TEST ONLY");
    for (const c of calls) assert.match(c, /--installer "\$bundle"/, c);
    assert.match(calls[0], /--pubkey-stable "\$PUBKEY_STABLE" --pubkey-beta "\$PUBKEY_BETA"/);
    assert.match(calls[1], /--test-key/);
    assert.match(run, /grep -q '@@PLUR1BUS_PLUGIN_PUBKEY_' "\$bundle"/);
    assert.match(run, /for f in "\$out\/install-plugin\.sh" "\$out\/install-plugin\.ps1" "\$bundle"/);
    assert.match(run, /if \[ "\$DRY_RUN" != true \] && \[ "\$test_key" = 1 \]; then .*exit 1; fi/);
    assert.ok(render < idx((s) => s.name === "Build the unsigned feed"), "render before the feed");
    assert.ok(render < idx((s) => s.name === "Write SHA256SUMS"), "render before SHA256SUMS");
    assert.ok(render > idx((s) => s.name === "Stage the release files"), "render after staging");

    // The marker the workflow greps is present in every TEST ONLY render and absent from every release render.
    const marker = /grep -qF '([^']+)' "\$f"/.exec(run)?.[1];
    assert.ok(marker, "the TEST ONLY marker grep");
    const raw = readFileSync(join(REPO, "scripts", "dist", "installer", "main.mjs"), "utf8");
    const stable = generateTestKeyPair().publicKeyLine;
    const beta = generateTestKeyPair().publicKeyLine;
    const release = renderBootstraps({ pubkeyStable: stable, pubkeyBeta: beta });
    const test = renderBootstraps({ testKey: true });
    for (const t of [release.sh, release.ps1, renderInstallerKeys(raw, { pubkeyStable: stable, pubkeyBeta: beta })]) {
      assert.ok(!t.includes(marker), "a release render carries no TEST ONLY marker");
      assert.ok(!t.includes("@@PLUR1BUS_PLUGIN_PUBKEY_"));
    }
    for (const t of [test.sh, test.ps1, renderInstallerKeys(raw, { testKey: true })]) assert.ok(t.includes(marker), "a TEST ONLY render carries the marker");
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
