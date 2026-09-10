/**
 * lib/process-singleton.js (7.12.36)
 *
 * Prozessweite Einzelstuecke fuer Zustand, der Plugin-Instanzen ueberleben
 * muss. OpenClaw 2026.9 legt je Agenten-Lauf eine neue Plugin-Instanz an
 * (`register()` lief am 10.09.2026 60-mal am Tag, zweimal je Turn). Ein
 * Register, das nur in der Closure einer Instanz lebt, sieht deshalb nie,
 * was eine andere Instanz eingetragen hat: das Dispatch-Ticket der Gateway-
 * Instanz blieb fuer den Prompt-Hook der Lauf-Instanz unsichtbar
 * (`claim:no_ticket pending=0`).
 *
 * Der Schluessel traegt eine Version; ein anderer Code-Stand im selben
 * Prozess (Hot-Reload) bekommt so sein eigenes Objekt.
 */

export function getProcessSingleton(key, factory) {
  const symbol = Symbol.for(String(key));
  const existing = globalThis[symbol];
  if (existing !== undefined) return existing;
  const created = factory();
  Object.defineProperty(globalThis, symbol, { value: created, configurable: true, enumerable: false, writable: true });
  return created;
}

export function resetProcessSingleton(key) {
  const symbol = Symbol.for(String(key));
  if (globalThis[symbol] === undefined) return false;
  delete globalThis[symbol];
  return true;
}
