# `memory.rebind` / `memory.unbind` (Contract 1.12.0, Vorschlag)

**Status:** Analyse und API-Vorschlag, nicht implementiert.
**Stand:** Contract 1.11.0 (`types/engine.d.ts`), geprüft gegen `origin/main` `9bafa047` (Plugin #217).
**Auftrag:** ADR-007 Q4 (Owner 2026-10-05): bei manuellem, bestätigtem Verknüpfen einer Kanal-Identität mit einem Harness-User werden `user`-Scope-Karten per Metadaten-Backfill auf den Ziel-Principal umgehängt. Direktes Schreiben in LanceDB ist nach D28/T7 verboten.
**Grundlage:** Harness-Plan `docs/superpowers/plans/2026-10-05-m7-importers.md`, Abschnitt „Engine API Proposal: memory.rebind“, mit der Korrektur unten (Umkehr über `rebindId`, nicht über Tausch von `from`/`to`).
**Dieser PR:** nur dieses Dokument. Kein Code, kein Contract-Bump, kein Tag, keine Implementierung.

---

## 1. Was 1.11.0 schon kann, und was fehlt

`Engine.memory` hat `list`, `show`, `forget`, `correct`, `share`, `state`, `propose`, `proposals.*`, `import`. Kein Member ändert `ownerUserId` einer bestehenden Zeile.

`share` kopiert eine Karte in einen anderen Scope und bettet neu ein. Q4 ist kein Share: dieselbe Zeile, derselbe Vektor, nur der Owner.

`MemoryDB.update` kann ein In-Place-Patch ohne Textänderung schreiben (`isContentChangingUpdate` prüft nur `text`/`summary`). Genau das ist der Schreibweg. Host und Importer dürfen ihn nicht selbst aufrufen.

`ownerUserId` ist schon eine Spalte (Default `''`). Die ACL akzeptiert sie nur als `^user:v1:[a-f0-9]{64}$` (`lib/acl-middleware.js`). Ein Backfill auf `user:v2:…` wäre nach dem Write auf dem Read-Pfad ungültig, solange diese Regex nicht mitgeht. `UserPrincipal` im Contract ist ebenfalls nur `` `user:v1:${string}` ``.

`stores.adopt` (1.11.0) prüft Legacy-Stores mit einem Cosine-Probe. `ADOPT_PROBE_MIN_ROWS` ist `1`: eine einzige endliche Score-Zeile reicht für das Count-Gate. Das ist zu wenig.

---

## 2. Warum der Plan-Reverse (from/to tauschen) falsch ist

Der Sketch im Harness-Plan:

```ts
memory.rebind({ fromPrincipal: toPrincipal, toPrincipal: fromPrincipal })
```

Match ist `scope = 'user' AND ownerUserId = fromPrincipal`. Nach dem ersten Rebind liegen die verschobenen Karten **und** die schon vorher beim Ziel-User liegenden Karten unter demselben `toPrincipal`. Ein zweiter Aufruf mit getauschten Argumenten würde **beide** Mengen zurückschieben, also auch die eigenen Karten des Ziel-Users.

Umkehrbar ist nur die Menge, die dieser eine Apply tatsächlich bewegt hat.

---

## 3. API-Vorschlag (additiv, 1.12.0)

Neue optionale Member auf `MemoryOps`. Bestehende Member bleiben unverändert. `ContractVersion` wird bei der späteren Implementierung `"1.12.0"`.

### Signaturen

```ts
type UserPrincipal = `user:v1:${string}` | `user:v2:${string}`;
// on-disk / request strings still match ^user:v[12]:[a-f0-9]{64}$

interface MemoryRebindRequest {
  agentId: AgentId;
  fromPrincipal: string;
  toPrincipal: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

interface MemoryRebindResult {
  agentId: AgentId;
  dryRun: boolean;
  matchedCount: number;   // user-scope live rows with ownerUserId === fromPrincipal
  reboundCount: number;   // rows updated (0 when dryRun is true)
  skippedCount: number;   // matched but not updated (should stay 0 on the happy path)
  rebindId?: string;      // UUID v4; omitted on dryRun and when reboundCount === 0
}

interface MemoryUnbindRequest {
  agentId: AgentId;
  rebindId: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

interface MemoryUnbindResult {
  agentId: AgentId;
  rebindId: string;
  dryRun: boolean;
  matchedCount: number;   // card ids listed in the sidecar
  unboundCount: number;   // rows actually restored (0 when dryRun is true)
  skippedCount: number;   // listed ids not restored (gone, or owner no longer toPrincipal)
}

interface MemoryOps {
  // 1.5.0–1.11.0 unverändert …
  rebind(req: MemoryRebindRequest, p: Principal, a: AgentContext): Promise<MemoryRebindResult>;
  unbind(req: MemoryUnbindRequest, p: Principal, a: AgentContext): Promise<MemoryUnbindResult>;
}
```

`p.agentId` und `req.agentId` müssen übereinstimmen, sonst `invalid-input`. `p` ist der Operator (Importer / Owner-CLI). `a.origin === "system"` und `a.background === false`, analog `memory.import`. Die Destructive-Guard in `engine/memory-ops/context.js` (`origin !== "user"` → `denied`) gilt für `forget`/`correct`/`share`, nicht für Rebind/Unbind.

### Match (nur Scope `user`)

Eine Zeile ist ein Treffer, wenn **alle** gelten:

- `scope === "user"`
- `ownerUserId === fromPrincipal`
- Live-Status: `status` ist `active`, `''` oder null/undefined (wie Import-Live-Set)
- `id` besteht `safeUuid`

Kein anderer Scope (`agent-private`, `workspace`, `knowledge`). Kein Filter über Kartentext, Kategorie, Provenienz oder Vektor. Karten, die schon `ownerUserId === toPrincipal` haben, sind **kein** Treffer.

`fromPrincipal === toPrincipal` → `invalid-input`, kein Scan. Beide Strings müssen `^user:v[12]:[a-f0-9]{64}$` erfüllen, sonst `invalid-input`. `agentId` durch `safeAgentId`.

### Apply

1. `rebindId = randomUUID()` (v4, lowercase).
2. Sidecar atomar anlegen (`wx`), Inhalt siehe Abschnitt 4. Noch keine Zeilenmutation.
3. Pro Treffer-Zeile `MemoryDB.update` mit Patch `{ ownerUserId: toPrincipal, updatedAt: clock(), rebindId }`. **Kein** `vector`, **kein** `text`, **kein** `summary`. `isContentChangingUpdate` bleibt false, Tombstone-Guard und Re-Embed laufen nicht.
4. `reboundCount` = erfolgreich gepatchte Zeilen. Eine einzelne Update-Exception bricht den Rest ab (`storage`); Sidecar bleibt, Unbind kann die schon geschriebenen Zeilen zurückdrehen. Kein stilles Weiterlaufen ohne Audit.

`dryRun: true`: Scan und Zähler wie nach Apply, `reboundCount: 0`, kein Sidecar, kein Update, kein `rebindId` in der Antwort.

Zweiter Apply mit denselben `fromPrincipal`/`toPrincipal` auf demselben Agenten, ohne neue Quell-Karten dazwischen: `matchedCount: 0`, `reboundCount: 0`, kein neues Sidecar, kein `rebindId`. Das ist die Idempotenz. Neue Karten, die **nach** dem ersten Apply noch unter `fromPrincipal` liegen, sind ein **neuer** Apply mit neuem `rebindId` (eigene Audit-Menge).

### Unbind

Lookup Sidecar `rebindId` unter `req.agentId`. Fehlt die Datei oder ist sie unlesbar → `not-found`. `rebindId` muss `safeUuid` sein.

Pro Sidecar-Eintrag:

- Karte weg (`getById` leer) → `skippedCount++`, nicht anlegen.
- `ownerUserId` ist nicht mehr `toPrincipal` der Sidecar-Akte (späterer Rebind hat die Zeile weitergeschoben, oder jemand hat anders gepatcht) → `skippedCount++`, nicht zurückschreiben. Sonst würde Unbind(R1) einen späteren Rebind R2 still zerstören.
- sonst: Patch `{ ownerUserId: fromOwnerUserId, updatedAt: fromUpdatedAt, rebindId: "" }`. Wieder kein Vektor, kein Text.

Nach erfolgreichem Apply-Unbind: Sidecar-Status `reversed`. Zweiter Unbind derselben `rebindId`: Karten liegen schon auf `fromPrincipal` → `unboundCount: 0`, `skippedCount` = alle (Owner passt nicht mehr auf `toPrincipal`), Sidecar bleibt `reversed`. Kein zweites Zurückschreiben, kein Anfassen der Ziel-User-Karten.

`dryRun: true` auf Unbind: Zähler, keine Writes, Sidecar-Status unverändert.

Unbind ist die **einzige** Umkehr. Ein Rebind mit getauschten Principal-Strings ist ein neuer Forward-Move und gehört nicht in Tests als Reverse.

### Was die Antwort und die Logs nicht enthalten

Kein Kartentext, kein Summary, kein `sourceRef`, kein Embedding, keine Vektoren. Ergebnis nur Zähler plus `rebindId` / `agentId` / `dryRun`. Logs: `agentId`, `rebindId`, Zähler, Error-Codes. `MemoryOpError.message` bleibt log-safe. Principal-Strings sind Hashes; trotzdem nicht in Info-Logs (Debug darf `from`/`to` als ganze Principal-Strings, nie Karteninhalt).

Karten-IDs stehen nur im Sidecar, nicht in `MemoryRebindResult`.

---

## 4. Audit-Sidecar und Stempel auf der Zeile

### Sidecar (Quelle für Unbind)

Pfad: `{baseDbPath}/_rebinds/<agentId>/<rebindId>.json`

Verzeichnis `0o700`, Datei `0o600`. Pfad über `resolveInside` + `safeAgentId` + `safeUuid`, analog `_imports/`. Anlegen mit `"wx"` (existiert → `conflict`, kein zweites Sidecar derselben Id).

```json
{
  "v": 1,
  "rebindId": "<uuid>",
  "agentId": "<agentId>",
  "fromPrincipal": "user:v1:<64 hex>",
  "toPrincipal": "user:v2:<64 hex>",
  "createdAt": 0,
  "actor": "user:v2:<64 hex>",
  "status": "applied",
  "cards": [
    { "id": "<uuid>", "fromOwnerUserId": "user:v1:<64 hex>", "fromUpdatedAt": 0 }
  ]
}
```

`status` ist `"applied"` | `"reversed"`. `actor` ist der aufgelöste Operator-Principal (`memoryCtx.userPrincipal`) oder `principal:<agentId>`, nie ein Klarname, nie ein Token. `cards` enthält **nur** IDs und die zwei restaurierbaren Metadaten. Kein Text.

`dryRun` schreibt diese Datei nicht. Ein Apply mit `matchedCount: 0` schreibt sie nicht.

Unbind setzt `status: "reversed"` und `reversedAt: clock()` in derselben Datei (atomar ersetzen, nicht löschen). Die Kartenliste bleibt, damit ein Review die Akte noch lesen kann.

### Stempel auf der Zeile

Jede verschobene Zeile bekommt `rebindId` als Spalte. Additive LanceDB-Spalte nach dem bestehenden `addColumns`-Muster (`valueSql: "''"`), Fallback `record.rebindId ?? ""`. **Kein** `STORE_SCHEMA_VERSION` 1→2 (wie `ownerUserId` damals). Unbind schreibt `rebindId` zurück auf `''`.

Die Spalte ist denormalisiert: Unbind entscheidet anhand des Sidecars, nicht anhand der Spalte. Die Spalte erlaubt `list`/`show` und Crash-Diagnose („diese Zeile gehört zu Akte R“). `MemoryCard` bekommt optional `rebindId?: string` (leer/fehlend = nicht Teil einer offenen Akte).

Reihenfolge: Sidecar `wx` zuerst, dann Patches. Absturz dazwischen: Unbind findet die Akte und stellt die schon gepatchten Zeilen zurück; ungepatchte liegen noch auf `fromPrincipal` und werden beim Unbind `skipped` (Owner ≠ `toPrincipal`) bzw. bleiben korrekt auf `fromPrincipal`.

---

## 5. `user:v2` auf dem Write- und Read-Pfad

Q4 hängt v1-Karten an den kanonischen User (`user:v2:` + sha256(subject.id) in ADR-007). Ohne Regex-Weitung wirft `validateOwnership` nach dem Write `"invalid user ownership principal"`, die Karten sind tot.

1.12.0 weitet **nur** die akzeptierte Principal-Form:

- `UserPrincipal` = `` `user:v1:${string}` | `user:v2:${string}` ``
- `lib/acl-middleware.js` und derselbe Check an anderen Stellen: `^user:v[12]:[a-f0-9]{64}$`
- `ownerUserId` darf v2 speichern und lesen

Nicht in 1.12.0 (eigene ADR-007-PRs): `subject` auf `Principal`, Ableitung `user:v2` in der Engine, `linkedIdentities`, Union-Recall. Rebind schreibt den `toPrincipal`-String, den der Host schon kennt. Die Engine rechnet in diesem PR keine v2-Formel.

OpenClaw-Adapter ohne v2: unverändert, solange er nur v1 schreibt.

---

## 6. Single-Writer (wie Import)

Unverändert zu 1.11.0 Abschnitt 4 der Import-Spec:

- Die Engine hat kein Cross-Process-Lock.
- Der Host hält `state/core.lock`, Core ist weg, dann `createEngine` im selben Prozess.
- Rebind/Unbind intern: `pool.withWriteDb(agentId, …)`.
- Kein `@lancedb/lancedb` im Harness-Importer, kein direktes `MemoryDB.update` außerhalb der Engine.

`target-running` bleibt Host-Sache, kein neues Engine-Lockfile.

---

## 7. Nebenbei: `ADOPT_PROBE_MIN_ROWS`

Heute (`engine/stores/adopt.js`):

```js
export const ADOPT_PROBE_MIN_ROWS = 1;
const finite = scores.length >= ADOPT_PROBE_MIN_ROWS && scores.every(Number.isFinite);
```

`ADOPT_PROBE_SIZE` bleibt 16 (Scan-Deckel). Die Count-Schwelle wird:

```js
const availableValidRows = sample.length; // Zeilen mit Text + endlichem Vektor erwarteter Dimension
const minRows = Math.min(8, availableValidRows);
const finite = scores.length >= minRows && scores.every(Number.isFinite);
```

- `availableValidRows === 0` auf dem Probe-Pfad: `identity-unverifiable` (heute schon, außer Manifest-Treffer ohne Zeilen).
- Weniger endliche Scores als `minRows` (NaN, fehlender Fresh-Vektor nach Re-Embed): `identity-unverifiable`.
- Store mit 3 gültigen Zeilen: `minRows = 3`, alle drei müssen endliche Scores liefern. Store mit 20: `minRows = 8` aus dem 16er-Sample.

Cosine-Böden (`ADOPT_PROBE_MIN_COSINE` 0.999, Median 0.9995) und das positive Gate (`>=`, kein NaN-fail-open) bleiben. Manifest-Pfad ohne Probe-Zeilen bleibt `ok`, wenn das Manifest zur erwarteten Identität passt.

---

## 8. Abweichungen vom Sketch im Harness-Plan

| Sketch im Plan | Dieser Vorschlag |
|---|---|
| Reverse = `from`/`to` tauschen | `memory.unbind({ rebindId })` über Sidecar; Tausch ist ein neuer Forward-Move |
| kein `rebindId` | UUID v4 pro Apply, Stempel auf der Zeile, Akte unter `_rebinds/` |
| `agentId?` (alle Stores) | `agentId` Pflicht; Host iteriert (wie `memory.import`) |
| Ergebnis nur `matchedCount` / `reboundCount` | plus `skippedCount`, `rebindId`, `agentId` |
| Principal-Form unspezifiziert | `user:v1` und `user:v2`, 64 Hex; ACL-Regex weitet mit |
| Scope implizit user | hart `scope === "user"` |
| — | `ADOPT_PROBE_MIN_ROWS = min(8, availableValidRows)` |

Batch-2-Linking im Harness bleibt auf diesem Member sitzen, bis die Implementierung nach Review da ist.

---

## 9. Offene Punkte (nicht geraten)

| Id | Thema | Vorschlag zum Review |
|---|---|---|
| R1 | `agentId` Pflicht vs. alle Agenten in einem Call | Pflicht, Host-Schleife. Ein Call über alle Stores ist ein größerer Blast-Radius und eine Akte pro Agent ist klarer. |
| R2 | Archivierte / gelöschte Zeilen mitnehmen? | Nein beim Forward-Match (nur live). Unbind restauriert gelistete IDs unabhängig vom späteren Status, sofern `ownerUserId` noch `toPrincipal` ist. |
| R3 | `appendDestructiveOpLog` zusätzlich zum Sidecar | Ja, eine Zeile `{ op: "memory.rebind" \| "memory.unbind", rebindId, matchedCount, reboundCount }` ohne Inhalt. Sidecar bleibt die Umkehr-Akte. |
| R4 | Obsidian-Frontmatter `owner` nachziehen | Nein in 1.12.0. LanceDB ist maßgeblich; Vault-Mirror ist ein Folgeauftrag. |
| R5 | `UserPrincipal`-Union weiten vs. `string` nur in Rebind | Union weiten, sonst ist v2 im übrigen Contract unsichtbar und `list`/`show` lügen. |
| R6 | `MemoryCard.rebindId` öffentlich | optional string, leer weglassen. Adapter müssen das Feld nicht anzeigen. |
| R7 | Partial-Apply nach Crash | Sidecar behalten, Unbind ist die Recovery. Kein automatisches Fortsetzen desselben `rebindId`. |

---

## 10. Testplan (nach Review, eigener Implementierungs-PR)

Keine Tests in diesem PR. Zielort später: `tests/engine-memory-rebind.test.js`, Probe-Änderung in den bestehenden Adopt-Tests.

### Rebind / Unbind

- Live-Karten unter `from` (user-Scope) plus eigene Karten unter `to` plus eine `agent-private`-Karte. Apply: nur die `from`-User-Karten bewegen sich. `to`-Karten: gleiches `ownerUserId`, gleiches `updatedAt`, gleicher Vektor (Byte-Vergleich bzw. gleiche Floats). `agent-private` unberührt.
- Apply dann Unbind: `ownerUserId`, `updatedAt` und `rebindId` (`''`) der bewegten Zeilen identisch zum Snapshot vor dem Apply. Vektoren unverändert. `to`-Karten weiter unberührt. Das ist „Ausgangszustand exakt“.
- Zweiter Apply unmittelbar nach dem ersten: `matchedCount: 0`, `reboundCount: 0`, kein neues Sidecar, Store byte-gleich zum Stand nach dem ersten Apply.
- `dryRun: true`: Zähler `matchedCount = N`, `reboundCount = 0`, Store und `_rebinds/` unverändert (auch kein `rebindId` in der Antwort).
- `fromPrincipal === toPrincipal` / kein `user:v[12]:` / `agentId` ≠ `p.agentId` → `invalid-input`, kein Write.
- Unbind unbekannte `rebindId` → `not-found`.
- Unbind nach Apply: `unboundCount` = `reboundCount` des Apply. Zweiter Unbind: `unboundCount: 0`.
- Karte zwischen Rebind und Unbind `forget`: Unbind skipped oder restauriert Metadaten auf der archivierten Zeile (R2); auf keinen Fall eine neue Live-Karte anlegen.
- Antwort-JSON und Logger-Mocks enthalten das Fixture-Token aus dem Kartentext nicht.
- Patch-Objekt an `MemoryDB.update` hat kein `vector` und kein `text` (Spy).
- `a.origin === "user"` → `denied` oder analog Import-Guard; `forget` bleibt für `origin: "system"` auf `denied`.

### Adopt-Probe

- Sample mit 8+ gültigen Zeilen: Gate `minRows = 8`.
- Sample mit 3 gültigen Zeilen, alle endliche Cosines über den Böden: `ok` (`minRows = 3`).
- Sample mit 3 gültigen Zeilen, davon 1 NaN-Score: `identity-unverifiable`.
- Sample leer, kein passendes Manifest: `identity-unverifiable`.
- Bestehende Adopt-Tests (Dimension, Manifest, Path-Escape, dryRun) bleiben grün.

### Conformance

Bei der Implementierung, nicht hier: `types/engine.d.ts` Changelog 1.12.0, `ContractVersion`, `types/engine.conformance.ts` (Member-Existenz, `UserPrincipal`-Union), `docs/engine-api.md`, `engine/create-engine.js` `contract: "1.12.0"`. Ein PR, Adapter und Contract zusammen. OpenClaw-Adapter muss `rebind`/`unbind` nicht aufrufen.

---

## 11. Dateien, die die Implementierung später anfassen würde

Nur zur Orientierung, in diesem PR unverändert:

- `types/engine.d.ts`, `types/engine.conformance.ts`
- `docs/engine-api.md`
- `engine/create-engine.js` (`contract`, MemoryOps-Bindung)
- `engine/memory-ops/` (neu `rebind.js`, Sidecar analog `import-ledger.js`)
- `engine/store/memory-db.js` (`addColumns` für `rebindId`)
- `lib/acl-middleware.js` (Principal-Regex)
- `engine/stores/adopt.js` (`ADOPT_PROBE_MIN_ROWS`)
- Tests wie in Abschnitt 10

Kein `adapter/openclaw/**` außer falls die Regex-Weitung dort gespiegelt werden muss, kein Harness-Code, keine Versionsfelder in `package.json`, `crates/plur1bus` liegt nicht in diesem Repo.
