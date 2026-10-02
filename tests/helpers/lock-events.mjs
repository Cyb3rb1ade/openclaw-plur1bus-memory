// tests/helpers/lock-events.mjs — TEST ONLY: the checker for the registry-lock event logs that
// tests/dist-hermes-lock-interop.test.js and the JS-only contention test in tests/dist-hermes-install.test.js write.
//
// Each hold logs one line per event, `<kind> <holder id> <seq> [timestamp]`, as one atomic append:
//   E entered; L its verify (assertHeld / held.verify) refused, nothing written; W the guarded write ran (only after
//   a verify that passed); X left; D about to die holding the lock (no write).
// Ruling FR-L1 accepts a short put-back window in which a third process enters while a displaced holder is still
// inside; safety rests on the displaced holder's verify refusing. So an overlap is reported, and it is a violation
// only when a holder already inside then writes (W) or leaves without having refused (no L), or when two holders
// that both wrote are inside together. Every section must end exactly once.

/**
 * Check the event log; returns { violations, overlaps, counts }. Each overlap is { line, newcomer, inside, refused }:
 * `refused` is true when every holder already inside logged L (the FR-L1 case).
 */
export function checkEvents(lines) {
  const violations = [];
  const overlaps = [];
  const inside = new Map(); // key -> { lost, wrote, mustLose }
  const ended = new Set();
  const lostKeys = new Set();
  const counts = { E: 0, W: 0, L: 0, X: 0, D: 0 };
  for (const [i, line] of lines.entries()) {
    const [kind, id, seq] = line.split(" ");
    const key = `${id}#${seq}`;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === "E") {
      if (inside.has(key) || ended.has(key)) violations.push(`line ${i + 1}: ${key} entered twice`);
      if (inside.size) {
        overlaps.push({ line: i + 1, newcomer: key, inside: [...inside.keys()] });
        for (const s of inside.values()) s.mustLose = true;
      }
      inside.set(key, { lost: false, wrote: false, mustLose: false });
      continue;
    }
    const s = inside.get(key);
    if (!s) {
      violations.push(`line ${i + 1}: ${kind} for ${key}, which is not inside`);
      continue;
    }
    if (kind === "L") {
      s.lost = true;
      lostKeys.add(key);
    }
    else if (kind === "W") {
      if (s.mustLose) violations.push(`line ${i + 1}: ${key} wrote although a newcomer entered after it (its verify should have refused)`);
      for (const [k, o] of inside) if (k !== key && o.wrote) violations.push(`line ${i + 1}: ${key} wrote while ${k}, which also wrote, was inside (double entry in the guarded section)`);
      s.wrote = true;
    } else if (kind === "X" || kind === "D") {
      if (s.mustLose && !s.lost) violations.push(`line ${i + 1}: ${key} was displaced (someone entered after it) but its verify did not refuse`);
      inside.delete(key);
      ended.add(key);
    } else violations.push(`line ${i + 1}: unknown event ${JSON.stringify(line)}`);
  }
  for (const k of inside.keys()) violations.push(`${k} never left (no X or D)`);
  for (const o of overlaps) o.refused = o.inside.every((k) => lostKeys.has(k));
  return { violations, overlaps, counts };
}

/** Takeovers of a dead holder's lock: for each D, the language of the next E (`js->py` = a py holder after a dead js one). */
export function takeovers(lines) {
  const out = { "js->py": 0, "py->js": 0, "js->js": 0, "py->py": 0 };
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith("D ")) continue;
    const next = lines.slice(i + 1).find((l) => l.startsWith("E "));
    if (!next) continue;
    const from = line.split(" ")[1].slice(0, 2);
    const to = next.split(" ")[1].slice(0, 2);
    out[`${from}->${to}`]++;
  }
  return out;
}
