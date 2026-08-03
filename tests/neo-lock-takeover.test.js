/**
 * Regressionstest für den Stale-Lock-Takeover in lib/neo-arch.js.
 *
 * Hintergrund: `.neo-write.lock` ist ein Verzeichnis-Mutex. Stirbt der Halter
 * im kritischen Abschnitt (Gateway-Crash), blieb das Verzeichnis früher für
 * immer liegen und JEDER weitere Write lief in NEO_WRITE_BACKPRESSURE — im
 * Feld waren dadurch die Episoden zweier Agenten tagelang tot.
 *
 * Die zwei Richtungen müssen beide halten:
 *   - toter Halter    → Lock wird übernommen
 *   - lebender Halter → Lock wird NICHT gestohlen
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore } from "../lib/neo-arch.js";

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), "neo-lock-takeover-"));
  const store = createNeoStore(root, "workspace");
  mkdirSync(store.paths.workspaceDir, { recursive: true });
  return { root, store, lockPath: join(store.paths.workspaceDir, ".neo-write.lock") };
}

/** PID, die garantiert nicht existiert. */
function deadPid() {
  for (let pid = 4_000_000; pid > 100_000; pid -= 7919) {
    try { process.kill(pid, 0); } catch (error) {
      if (error?.code === "ESRCH") return pid;
    }
  }
  throw new Error("keine tote PID gefunden");
}

function ageLock(lockPath, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(lockPath, when, when);
}

describe("neo workspace write lock", () => {
  it("übernimmt ein Lock, dessen Halter-PID nicht mehr existiert", () => {
    const { root, store, lockPath } = freshStore();
    try {
      mkdirSync(lockPath, { recursive: false });
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: deadPid(),
        acquiredAt: new Date().toISOString(),
      }), "utf8");

      // Darf NICHT mit NEO_WRITE_BACKPRESSURE scheitern.
      store.appendEpisodes([{ id: "ep_takeover", agentId: "main", title: "nach Takeover" }]);

      assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_takeover/);
      assert.equal(existsSync(lockPath), false, "Lock muss nach dem Write wieder freigegeben sein");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("übernimmt ein altes Lock ohne owner.json (Alt-Format früherer Versionen)", () => {
    const { root, store, lockPath } = freshStore();
    try {
      mkdirSync(lockPath, { recursive: false });
      ageLock(lockPath, 10 * 60_000); // deutlich über der Orphan-Grace von 15s
      store.appendEpisodes([{ id: "ep_orphan", agentId: "main", title: "nach Orphan-Takeover" }]);
      assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_orphan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("übernimmt ein überaltertes Lock auch bei lebender PID (deckt PID-Wiederverwendung ab)", () => {
    const { root, store, lockPath } = freshStore();
    try {
      mkdirSync(lockPath, { recursive: false });
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid, // lebt, aber das Lock ist uralt
        acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }), "utf8");
      ageLock(lockPath, 60 * 60_000); // 1h > NEO_LOCK_STALE_MS (5min)

      store.appendEpisodes([{ id: "ep_aged", agentId: "main" }]);
      assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_aged/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stiehlt einem lebenden Halter das frische Lock NICHT und meldet Backpressure", () => {
    const { root, store, lockPath } = freshStore();
    try {
      mkdirSync(lockPath, { recursive: false });
      // Eigene, garantiert lebende PID mit frischem Zeitstempel.
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }), "utf8");

      assert.throws(
        () => store.appendEpisodes([{ id: "ep_nosteal", agentId: "main" }]),
        (error) => error?.code === "NEO_WRITE_BACKPRESSURE",
        "lebender Halter darf nicht übernommen werden",
      );
      assert.equal(existsSync(lockPath), true, "fremdes Lock muss unangetastet bleiben");
      assert.equal(existsSync(store.paths.episodes), false, "es darf nichts geschrieben worden sein");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gibt das Lock auch frei, wenn die Aktion im kritischen Abschnitt wirft", () => {
    const { root, store, lockPath } = freshStore();
    try {
      // BigInt ist nicht JSON-serialisierbar — wirft innerhalb des Locks.
      assert.throws(() => store.appendEpisodes([{ id: "ep_boom", bad: 1n }]), TypeError);
      assert.equal(existsSync(lockPath), false, "Lock darf nach einem Fehler nicht liegenbleiben");

      // Und der nächste, gesunde Write muss wieder durchgehen.
      store.appendEpisodes([{ id: "ep_after_boom", agentId: "main" }]);
      assert.match(readFileSync(store.paths.episodes, "utf8"), /ep_after_boom/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
