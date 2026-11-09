import React from 'react';
import * as sdk from '@hermes/plugin-sdk';
// Optional newer exports must not prevent the diagnostic/fallback from loading.
const { host, useValue, STATUSBAR_AREAS, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA } = sdk;

let translateLocale;
const locale = () => translateLocale?.('language') === 'de' ? 'de' : 'en';
const useLocale = sdk.usePluginI18n || (() => undefined);
const tr = (english, german, ...values) => (locale() === 'de' ? german : english)
  .replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]));

/** Project only the active private agent; unknown counts remain unknown.
 * @param {object} status Profile-bound backend status.
 * @returns {object[]} Safe rows for the active-profile card.
 */
export function primaryAgentRows(status) {
  if (status?.scopeType !== 'agent-private') return [];
  const rows = status.cards?.byPrimaryAgent;
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => row && row.id === status.agentId).map(row => ({
    id: row.id, profile: typeof row.profile === 'string' ? row.profile : '',
    cards: Number.isSafeInteger(row.cards) && row.cards >= 0 ? row.cards : null,
  }));
}

/** Read-only startup check; source patch presence is never inferred from an API name.
 * @param {object} runtime Hermes SDK host.
 * @param {Function} rest Plugin-scoped SDK REST.
 * @param {Function} current Current profile/connection identity.
 * @returns {Promise<object>} Safe capability report, without memory reads or writes.
 */
export async function checkDesktopCompatibility(runtime, rest, current) {
  const identity = current();
  const [connection, profile] = JSON.parse(identity);
  const missing = [];
  if (typeof runtime.profileRoutes !== 'function') missing.push(tr('profile routing API', 'Profilrouting-API'));
  if (typeof rest !== 'function') missing.push('Plugin REST API');
  const base = { identity, sidebar: 'unknown', profileBinding: false, enabled: null };
  if (missing.length) return { ...base, status: 'unsupported',
    message: tr("Hermes Desktop needs an update: {0} is missing.", "Hermes Desktop benötigt ein Update: {0} fehlt. Es wurde nichts verändert.", missing.join(', ')) };
  try {
    const request = createProfileTransport(rest, runtime, { connection, profile }, current, identity);
    const caps = await request('/desktop/capabilities');
    if (current() !== identity) return { ...base, status: 'stale' };
    return { ...base, profileBinding: true, enabled: typeof caps.memoryProviderEnabled === 'boolean' ? caps.memoryProviderEnabled : null,
      status: 'verified', message: tr("Profile connection verified. Requests are scoped to the selected profile.", "Profilverbindung geprüft. Datenzugriff bleibt an das aktuell ausgewählte Profil gebunden.") };
  } catch (error) {
    return { ...base, status: current() !== identity ? 'stale' : 'blocked',
      enabled: null,
      message: error?.plur1busReason || tr("The profile connection could not be verified. Data access is blocked.", "Profilverbindung nicht bestätigt. Datenzugriff bleibt gesperrt.") };
  }
}

/** Explain whether activation makes profile navigation visible.
 * @param {object|null} report Read-only compatibility result.
 * @returns {string} Actionable message for the selected profile.
 */
export function compatibilityActivationMessage(report) {
  if (!report || report.status !== 'verified') return tr("Activation status is unknown. Verify the profile connection first.", "Aktivierungsstatus unbekannt. Profilverbindung zuerst prüfen.");
  if (report.enabled === false) return tr("Set PLUR1BUS as the active memory provider in this Hermes profile, then restart its backend to show the sidebar and status bar entries.", "PLUR1BUS ist für dieses Profil nicht als aktiver Memory-Provider eingerichtet. Deshalb sind Sidebar- und Statusleisten-Eintrag ausgeblendet. Im Hermes-Profil memory.provider=plur1bus und memory.memory_enabled=true setzen, das Backend neu starten und erneut prüfen.");
  if (report.enabled === true) return tr("PLUR1BUS is active in this profile. Its navigation entry should be visible.", "PLUR1BUS ist in diesem Profil aktiv. Der Navigationseintrag sollte sichtbar sein.");
  return tr("The profile connection is verified. The backend has not confirmed PLUR1BUS activation.", "Profilverbindung ist geprüft, der PLUR1BUS-Aktivierungsstatus ist vom Backend aber nicht bestätigt.");
}

function HostCompatibility({ rest }) {
  useLocale('plur1bus');
  const [report, setReport] = React.useState(null);
  const profile = useValue(host.state.profile), connection = useValue(host.state.connectionId);
  React.useEffect(() => {
    let disposed = false;
    setReport(null);
    const identity = scopeKey();
    async function check() {
      const result = await checkDesktopCompatibility(host, rest, scopeKey);
      if (!disposed && scopeKey() === identity && result.status !== 'stale') setReport(result);
    }
    void check();
    return () => { disposed = true; };
  }, [profile, connection]);
  return h('section', null, h('h2', null, tr("Hermes compatibility", "Hermes-Kompatibilität")),
    h('p', { role: 'status' }, report?.message || tr("Checking Hermes capabilities and profile routing…", "Host-Funktionen und Profilzuordnung werden schreibgeschützt geprüft…")),
    h('p', { role: 'status', className: report?.enabled === false ? 'pb-error' : undefined }, compatibilityActivationMessage(report)),
    h('p', null, tr("You can also open PLUR1BUS from the status bar or command palette. Data and actions require a verified profile connection.", "Fehlt der linke Knopf: PLUR1BUS über die untere Statusleiste oder Befehlspalette öffnen. Bei nicht bestätigter Profilverbindung bleiben Daten und Aktionen gesperrt.")));
}

/** Explain scoped native LLM failure counters without implying missing data is healthy.
 * @param {object} status Profile-bound status response.
 * @returns {React.ReactNode} A readable health summary for the selected profile.
 */
function HealthWatch({ status }) {
  const health = status?.health;
  const llm = health?.llm;
  const rows = llm?.failures;
  const hintLabels = {
    'authority-expired': tr("The profile authorization expired during the request", "Profilberechtigung war während des Aufrufs nicht mehr aktiv"),
    timeout: tr("Request timed out", "Zeitüberschreitung"), unavailable: tr("Model or provider unavailable", "Modell oder Anbieter nicht erreichbar"),
    rate_limited: tr("Provider rate limited the request", "Anbieter hat die Anfrage begrenzt"), unknown: tr("Unknown cause", "Ursache nicht klassifiziert"),
  };
  const stateLabel = { ready: tr("Individual failures recorded", "Einzelne Fehler erfasst"), degraded: tr("Repeated failures detected", "Wiederholte Fehler erkannt"), unavailable: tr("Status unavailable", "Status nicht verfügbar") };
  return h('section', { className: 'pb-health-watch' }, h('h2', null, tr('Model requests', 'LLM-Aufrufe')),
    rows == null ? h('p', { role: 'status' }, tr("Status unknown. This backend has not reported health data.", "Status unbekannt. Dieses Backend liefert noch keine Health-Watch-Daten.")) :
      !Array.isArray(rows) ? h('p', { role: 'status' }, tr("Status unknown. Failure data is invalid.", "Status unbekannt. Fehlerdaten sind ungültig.")) : rows.length === 0
        ? h('p', { role: 'status' }, tr("{0} · no failures in the last {1} hours.", "{0} · keine Fehler in den letzten {1} Stunden.", stateLabel[llm.state] || stateLabel.unavailable, health?.windowHours || 24))
        : h(React.Fragment, null,
          h('p', { role: 'status', className: llm.state === 'degraded' ? 'pb-error' : undefined },
            tr("{0} · internal model requests for this profile over the last {1} hours.", "{0} · interne Modellaufrufe dieses Profils in den letzten {1} Stunden.", stateLabel[llm.state] || stateLabel.ready, health?.windowHours || 24)),
          h('ul', { className: 'pb-health-list' }, ...rows.map((row, index) => {
            const when = Number.isFinite(row?.lastAt) && row.lastAt > 0
              ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.lastAt * 1000))
              : tr("Time unavailable", "Zeitpunkt nicht verfügbar");
            return h('li', { key: `${row?.feature || 'llm'}-${row?.hint || 'unknown'}-${index}` },
              h('strong', null, tr('{0} failed requests', '{0} fehlgeschlagene Aufrufe',
                Number.isSafeInteger(row?.count) && row.count >= 0 ? row.count : '–')),
              h('p', null, hintLabels[row?.hint] || tr("Model request failed", "Modellaufruf fehlgeschlagen")),
              h('small', null, tr('{0} · {1} · last seen {2}', '{0} · {1} · zuletzt {2}', row?.feature || tr('Model task', 'LLM-Funktion'),
                row?.errorClass || tr('Unknown error type', 'Fehlerklasse unbekannt'), when)));
          }))));
}

/** Read only the active backend; discard late responses.
 * @param {Function} rest Host REST transport.
 * @param {Function} scope Current connection/profile identity.
 * @param {Function} publish State publisher for the mounted view.
 * @returns {object} Disposable status reader.
 */
export function createScopedReader(rest, scope, publish) {
  let sequence = 0;
  let disposed = false;
  return {
    async load() {
      if (disposed) return;
      const current = ++sequence, owner = scope();
      publish({ loading: true, status: null, proposals: [], error: '', workshopError: '' });
      const results = await Promise.allSettled([
        Promise.resolve().then(() => rest('/status', { timeoutMs: 10000 })),
        Promise.resolve().then(() => rest('/workshop/proposals', { timeoutMs: 10000 })),
      ]);
      if (disposed || current !== sequence || owner !== scope()) return;
      const [status, workshop] = results;
      publish({
        loading: false,
        status: status.status === 'fulfilled' ? status.value : null,
        proposals: workshop.status === 'fulfilled' && Array.isArray(workshop.value?.proposals)
          ? workshop.value.proposals : [],
        error: status.status === 'rejected' ? (status.reason?.plur1busReason
          || tr("Status unavailable. Check that PLUR1BUS is enabled for the active Hermes profile.", "Status nicht erreichbar. Prüfe, ob PLUR1BUS im aktiven Hermes-Profil aktiviert ist.")) : '',
        workshopError: workshop.status === 'rejected' ? tr("Workshop overview unavailable.", "Workshop-Übersicht derzeit nicht verfügbar.") : '',
      });
    },
    dispose() { disposed = true; sequence++; },
  };
}

const h = React.createElement;
const scopeKey = () => JSON.stringify([host.state.connectionId.get(), host.state.profile.get()]);
/**
 * Check the mounted route on each operation and use only plugin-owned SDK endpoints.
 * @param {Function} rest Plugin-scoped Hermes SDK REST.
 * @param {object} runtime Hermes SDK profile router.
 * @param {object} owner Mounted connection and profile.
 * @param {Function} current Current UI identity.
 * @param {string} identity Mounted UI identity.
 * @returns {Function} Profile-bound plugin transport.
 */
export function createProfileTransport(rest, runtime, owner, current, identity) {
  const unavailable = message => Object.assign(new Error(message), { plur1busReason: message });
  const check = () => {
    if (current() !== identity) throw new Error('PLUR1BUS profile changed');
  };
  return async (path, options = {}) => {
    check();
    const inventory = await runtime.profileRoutes();
    check();
    const matches = inventory.filter(route => route.profile === owner.profile
      && (!owner.connection || route.connectionId === owner.connection));
    if (matches.length !== 1 || !matches[0].connectionId || !matches[0].targetProfile) {
      throw unavailable(tr('No unambiguous Hermes connection is available for this profile.', 'Für dieses Profil ist keine eindeutige Hermes-Verbindung verfügbar.'));
    }
    const route = matches[0];
    const send = async (suffix, opts = {}, assertProfile = true) => {
      check();
      if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('#')
          || suffix.split('?')[0].split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) {
        throw new Error('Invalid PLUR1BUS API path');
      }
      const url = new URL(suffix, 'http://plur1bus.invalid');
      if (assertProfile) url.searchParams.set('expectedProfile', route.targetProfile);
      let result;
      try {
        result = await rest(url.pathname + url.search, { ...opts, timeoutMs: 10000 });
      } catch (error) {
        // Host errors can contain sensitive endpoint details.
        const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
        if (status === 404 || /404|not found/i.test(String(error?.message || ''))) {
          throw unavailable(tr('PLUR1BUS is unavailable on this profile connection.', 'Die PLUR1BUS-API ist auf dieser Backend-Route nicht verfügbar.'));
        }
        throw unavailable(tr('The profile request failed. Check the Hermes connection and backend.', 'Die Profilanfrage ist fehlgeschlagen. Prüfe die Hermes-Verbindung und das Backend.'));
      }
      check();
      return result;
    };
    const capabilities = await send('/desktop/capabilities', {}, false);
    if (capabilities?.profileBinding !== 1 || capabilities.profile !== route.targetProfile) {
      throw unavailable(tr('The backend did not confirm the selected profile. Update PLUR1BUS and restart that backend.', 'Das Backend hat das gewählte Profil nicht bestätigt. Aktualisiere PLUR1BUS und starte das Backend neu.'));
    }
    if (path === '/desktop/capabilities') return capabilities;
    if (capabilities.memoryProviderEnabled !== true) {
      throw unavailable(tr('PLUR1BUS is not the active memory provider in this profile.', 'PLUR1BUS ist in diesem Profil nicht der aktive Memory-Provider.'));
    }
    if (path.split('?')[0] === '/desktop/settings' && route.mode === 'local' && capabilities.hostedReadOnly === true
        && typeof runtime.requestProfile === 'function') {
      const call = async change => {
        check();
        const result = await runtime.requestProfile(route, 'plugin.plur1bus.settings',
          { ...change, expectedProfile: route.targetProfile }, 10000);
        check();
        return result;
      };
      if (options.method === 'PUT') {
        const { identifier, value, revision } = options.body || {};
        return call({ identifier, value, revision });
      }
      if (!options.method) {
        const settings = await send(path);
        try {
          const access = await call({});
          if (access?.writable === true && access.profile === route.targetProfile) {
            return { ...settings, readOnly: false, settingsRpcWrite: true };
          }
        } catch {
          check();
        }
        return settings;
      }
    }
    return send(path, options);
  };
}
const field = (label, value) => h('div', { key: label }, h('dt', null, label),
  h('dd', null, value == null || value === '' ? tr("Unavailable", "Nicht verfügbar") : String(value)));

/** Bind each operation to the mounted connection/profile; never deliver late results.
 * @param {Function} rest Host-authenticated, profile-aware REST transport.
 * @param {Function} scope Returns the current connection/profile identity.
 * @returns {object} Disposable request gate.
 */
export function createScopedRequest(rest, scope) {
  const owner = scope();
  let disposed = false;
  return {
    async run(path, options = {}) {
      if (disposed || scope() !== owner) return { stale: true };
      try {
        const value = await rest(path, { ...options, timeoutMs: 10000 });
        return disposed || scope() !== owner ? { stale: true } : { value };
      } catch {
        return disposed || scope() !== owner ? { stale: true } : { error: true };
      }
    },
    dispose() { disposed = true; },
  };
}

function useRequests(rest) {
  const request = React.useRef(null);
  React.useEffect(() => {
    const gate = createScopedRequest(rest, scopeKey);
    request.current = gate;
    return () => { gate.dispose(); request.current = null; };
  }, [rest]);
  return request;
}

function MemoryBrowser({ rest }) {
  const request = useRequests(rest);
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState('active');
  const [page, setPage] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const sequence = React.useRef(0);
  async function load(offset = 0) {
    const current = ++sequence.current;
    setBusy(true); setError(''); setPage(null);
    const params = new URLSearchParams({ query, status, offset: String(offset), limit: '20' });
    const result = await request.current?.run(`/memories?${params}`);
    if (!result || result.stale || current !== sequence.current) return;
    setBusy(false);
    if (result.error) setError(tr("Memory browser unavailable. Update the backend or try again.", "Memory-Browser nicht erreichbar. Backend aktualisieren oder erneut versuchen."));
    else setPage({ ...result.value, query, status });
  }
  return h('section', null, h('h2', null, 'Memory-Browser'),
    h('p', null, tr("Search the selected partition by literal text. This view is read-only.", "Liest nur die ausgewählte Partition. Wörtliche Textsuche, keine semantische Recall-Abfrage und keine Änderungen an Erinnerungen.")),
    h('form', { className: 'pb-actions', onSubmit: event => { event.preventDefault(); void load(); } },
      h('label', null, tr("Search text", "Text suchen"), h('input', { value: query, maxLength: 200, disabled: busy,
        onChange: event => setQuery(event.target.value), placeholder: tr("Leave blank to show all memories", "Leer lassen für alle Erinnerungen") })),
      h('label', null, 'Status', h('select', { value: status, disabled: busy, onChange: event => setStatus(event.target.value) },
        ['active', 'archived', 'superseded', 'deleted'].map(value => h('option', { key: value, value }, value)))),
      h('button', { disabled: busy, type: 'submit' }, busy ? tr("Reading…", "Wird gelesen…") : tr("Load memories", "Erinnerungen laden"))),
    error ? h('p', { role: 'alert' }, error) : null,
    page ? h(React.Fragment, null,
      h('p', { role: 'status' }, `${page.items?.length || 0} Ergebnisse · ab ${page.offset + 1} · ${page.status}`),
      h('ul', null, (page.items || []).map((item, index) => h('li', { key: `${item.id}-${index}` },
        h('details', null, h('summary', null, String(item.content || '(ohne Text)').slice(0, 140)),
          h('pre', null, String(item.content || '')),
          item.contentTruncated ? h('p', null, tr("Preview limited to 32,768 characters.", "Vorschau auf 32.768 Zeichen gekürzt; gespeicherter Text unverändert.")) : null,
          h('dl', { className: 'pb-grid' },
            ...['id', 'type', 'status', 'epistemicStatus', 'sourceRole', 'importance', 'createdAt', 'validFrom', 'validUntil', 'expiresAt']
              .filter(key => item[key] != null).map(key => field(key, item[key]))))))),
      h('div', { className: 'pb-actions' },
        h('button', { disabled: busy || !page.offset || query !== page.query || status !== page.status,
          onClick: () => { void load(Math.max(0, page.offset - 20)); } }, tr("Back", "Zurück")),
        h('button', { disabled: busy || !page.hasMore || page.offset >= 100000 || query !== page.query || status !== page.status,
          onClick: () => { void load(page.offset + 20); } }, tr("Next", "Weiter")))) : null);
}

function Obsidian({ rest, refresh }) {
  const request = useRequests(rest);
  const [review, setReview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [capable, setCapable] = React.useState(false);
  React.useEffect(() => {
    async function check() {
      const result = await request.current?.run('/desktop/capabilities');
      if (result && !result.stale) setCapable(result.value?.obsidianActions === true);
    }
    void check();
  }, [rest]);
  async function preview() {
    setBusy(true); setReview(null); setNotice('');
    const result = await request.current?.run('/obsidian/preview');
    if (!result || result.stale) return;
    setBusy(false);
    if (result.error) setNotice(tr("Could not review notes. Check the source, size limit and backend version.", "Notizen nicht prüfbar. Quelle, Größenlimit und Backend-Version prüfen."));
    else setReview({ ...result.value, expiresAt: Date.now() + result.value.expiresInSeconds * 1000 });
  }
  async function confirm() {
    if (!review || busy || !capable) return;
    if (Date.now() >= review.expiresAt) { setReview(null); setNotice(tr("The review expired. Review the change again.", "Prüfung abgelaufen. Bitte erneut prüfen.")); return; }
    setBusy(true);
    const result = await request.current?.run('/desktop/obsidian/sync', { method: 'POST', body: {
      revision: review.revision, nonce: review.nonce, confirmation: 'obsidian-sync',
    } });
    if (!result || result.stale) return;
    setBusy(false); setReview(null);
    setNotice(result.error ? tr("The import was not fully confirmed. Review it again. Previously imported notes will not be duplicated.", "Import nicht vollständig bestätigt. Erneut prüfen; erfolgreiche Teile werden nicht doppelt angelegt.")
      : tr("Reviewed and imported {0} notes.", "{0} Notizen geprüft und importiert. Originaldateien unverändert.", result.value.files));
    refresh();
  }
  return h('section', null, h('h2', null, 'Obsidian & Workspace'),
    h('p', null, tr("Review changed Markdown notes in this agent's configured workspace. The import adds observations.", "Geänderte Markdown-Notizen im konfigurierten Workspace dieses Agenten prüfen. Import fügt Beobachtungen hinzu; er überschreibt weder Notizen noch Erinnerungen.")),
    h('button', { disabled: busy || !capable, onClick: () => { void preview(); } }, busy ? tr("Reviewing…", "Wird geprüft…") : tr("Review changed notes", "Geänderte Notizen prüfen")),
    !capable ? h('p', null, tr("This action needs an updated, authenticated backend.", "Für diese Aktion wird das aktualisierte, authentifizierte Backend benötigt.")) : null,
    notice ? h('p', { role: 'status' }, notice) : null,
    review ? h('div', { className: 'pb-review' }, h('p', null, tr("Agent {0} · {1} changed notes", "Agent {0} · {1} geänderte Notizen", review.agentId, review.files.length)),
      h('ul', null, review.files.map(file => h('li', { key: file.path }, file.path, h('small', null, ` · SHA-256 ${file.sha256.slice(0, 12)}`)))),
      h('p', null, tr("Review the listed source files before approval. New file revisions create new observations.", "Bitte die aufgeführten Quelldateien vor der Freigabe prüfen. Neue Dateiversionen erzeugen neue Beobachtungen.")),
      h('button', { disabled: busy, onClick: () => setReview(null) }, tr("Cancel", "Abbrechen")),
      h('button', { disabled: busy || !review.files.length, onClick: () => { void confirm(); } }, tr("Import reviewed notes", "Geprüfte Notizen importieren"))) : null);
}

function Workshop({ rest, proposals, error, loading, refresh }) {
  const request = useRequests(rest);
  const [capable, setCapable] = React.useState(false);
  const [review, setReview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => {
    async function capabilities() {
      const result = await request.current?.run('/desktop/capabilities');
      if (result && !result.stale) setCapable(result.value?.workshopActions === true);
    }
    void capabilities();
  }, [rest]);
  async function inspect(proposal, verb) {
    setBusy(true); setNotice(''); setReview(null);
    const path = verb ? `/workshop/${verb}/preview/${encodeURIComponent(proposal.id)}?revision=${encodeURIComponent(proposal.revision)}`
      : `/workshop/proposals/${encodeURIComponent(proposal.id)}`;
    const result = await request.current?.run(path);
    if (!result || result.stale) return;
    setBusy(false);
    if (result.error) setNotice(tr("The proposal is unavailable or its revision has changed. Refresh the list.", "Vorschlag nicht mehr verfügbar oder Revision geändert. Bitte Liste aktualisieren."));
    else setReview({ verb, proposal: verb ? result.value.review : result.value, nonce: result.value.nonce,
      warning: result.value.warning, expiresAt: Date.now() + (result.value.expiresInSeconds || 0) * 1000 });
  }
  async function confirm() {
    if (!review?.verb || busy || !capable) return;
    if (Date.now() >= review.expiresAt) { setReview(null); setNotice(tr("The confirmation expired. Review the action again.", "Bestätigung abgelaufen. Bitte erneut prüfen.")); return; }
    setBusy(true); setNotice('');
    const result = await request.current?.run(`/desktop/workshop/${review.verb}`, { method: 'POST', body: {
      proposal_id: review.proposal.id, revision: review.proposal.revision, confirmation: review.verb, nonce: review.nonce,
    } });
    if (!result || result.stale) return;
    setBusy(false); setReview(null);
    setNotice(result.error ? tr("The action was not confirmed. Refresh the status before trying again.", "Aktion nicht bestätigt. Nicht automatisch wiederholt; Zustand aktualisieren und erneut prüfen.")
      : result.value?.activationPartial ? tr("The skill was published, but evidence confirmation is incomplete. Review Finish approval again.", "Skill veröffentlicht; Belegbestätigung noch unvollständig. „Freigabe abschließen“ erneut prüfen.") : tr("The workshop action completed.", "Workshop-Aktion erfolgreich."));
    refresh();
  }
  return h('section', null, h('h2', null, 'Skill Workshop · Mined Skills'),
    h('p', null, capable ? tr("Review proposals before approving them or publishing them as Hermes skills.", "Vorschläge prüfen und anschließend ausdrücklich freigeben oder als Hermes-Skill veröffentlichen.")
      : tr("Read-only view. Actions require an updated backend and native Hermes authentication.", "Lesende Ansicht. Für Aktionen wird der aktualisierte Backendteil und die native Hermes-Authentifizierung benötigt.")),
    error ? h('p', { role: 'alert' }, error) : null,
    notice ? h('p', { role: 'status' }, notice) : null,
    !loading && !error && !proposals.length ? h('p', null, tr("No proposals in the active scope.", "Keine Vorschläge im aktiven Scope.")) : null,
    h('ul', null, proposals.map((p, index) => h('li', { key: `${p.id}-${index}` },
      h('strong', null, String(p.title || p.skillName || tr("Untitled proposal", "Unbenannter Vorschlag"))),
      h('small', null, `Status: ${p.status || 'unbekannt'} · Revision: ${String(p.revision || '').slice(0, 12)}`),
      h('small', null, `Kategorie: ${p.category || '—'} · Konfidenz: ${p.confidence ?? '—'} · Belege: ${p.evidenceCount || 0}`),
      p.benefit ? h('p', null, String(p.benefit).slice(0, 500)) : null,
      p.createdAt ? h('small', null, `Gefunden: ${String(p.createdAt).slice(0, 10)}`) : null,
      h('div', { className: 'pb-actions' },
        h('button', { disabled: busy, onClick: () => { void inspect(p, null); } }, tr("View", "Ansehen")),
        p.status === 'pending_review' ? h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'approve'); } }, tr("Review approval", "Freigabe prüfen")) : null,
        p.status === 'approved' || p.activationPartial ? h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'publish'); } }, p.activationPartial ? tr("Finish approval", "Freigabe abschließen") : tr("Review publication", "Veröffentlichung prüfen")) : null,
        ['pending_review', 'approved'].includes(p.status) ? h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'reject'); } }, tr("Reject", "Ablehnen")) : null,
        p.status === 'published' ? h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'withdraw'); } }, tr("Withdraw", "Zurückziehen")) : null)))),
    review ? h('div', { className: 'pb-review' }, h('h3', null, review.proposal.title),
      review.verb === 'publish' ? h('p', { role: 'alert' }, tr("This skill will be visible to all agents in this Hermes profile. PLUR1BUS access controls do not apply to the published skill.", "Achtung: Dieser Skill wird profilweit sichtbar, auch für andere Agenten dieses Hermes-Profils. PLUR1BUS-ACLs schützen den veröffentlichten Skill nicht.")) : null,
      h('p', null, review.proposal.description), h('pre', null, review.proposal.instructions),
      review.proposal.benefit ? h('p', null, review.proposal.benefit) : null,
      review.warning ? h('p', { role: 'alert' }, review.warning) : null,
      h('p', null, tr("Evidence: {0} records · Revision: {1}", "Evidenz: {0} Datensätze · Revision: {1}", review.proposal.evidence?.length || 0, review.proposal.revision)),
      h('div', { className: 'pb-actions' }, h('button', { disabled: busy, onClick: () => setReview(null) }, tr("Close", "Schließen")),
        review.verb ? h('button', { disabled: busy, onClick: () => { void confirm(); } }, busy ? tr("Submitting…", "Wird übermittelt…")
          : ({ publish: tr("Confirm publication to this profile", "Profilweite Veröffentlichung bestätigen"), approve: tr("Confirm approval", "Freigabe bestätigen"),
            reject: tr("Confirm rejection", "Ablehnung bestätigen"), withdraw: tr("Confirm withdrawal", "Rücknahme bestätigen") })[review.verb]) : null)) : null);
}
const css = `
.plur1bus-desktop{padding:24px;max-width:1200px;width:100%;height:100%;overflow:auto;margin:0 auto;color:var(--foreground);font:inherit}
.plur1bus-desktop header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.plur1bus-desktop h1{font-size:24px;font-weight:650}.plur1bus-desktop h2{font-size:16px;font-weight:600;margin-bottom:12px}
.plur1bus-desktop p{margin:8px 0;line-height:1.5}.plur1bus-desktop .pb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:28px}
.plur1bus-desktop section{padding:0;margin:28px 0}
.plur1bus-desktop dt{font-size:12px;opacity:.65;margin-top:12px}.plur1bus-desktop dd{overflow-wrap:anywhere;margin:3px 0 0}
.plur1bus-desktop button{border:1px solid var(--border,#777);border-radius:6px;padding:7px 12px;background:var(--muted,transparent);cursor:pointer}
.plur1bus-desktop button:disabled{opacity:.5;cursor:wait}.plur1bus-desktop li{padding:10px 0;border-top:1px solid var(--border,#555)}
.plur1bus-desktop small{display:block;opacity:.7}.plur1bus-desktop .pb-error{color:var(--destructive,#f88)}
.plur1bus-desktop .pb-actions{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:12px 0}
.plur1bus-desktop input,.plur1bus-desktop select{display:block;border:1px solid var(--border,#555);padding:8px;background:var(--background,#222);color:inherit;border-radius:6px}
.plur1bus-desktop pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:12px;background:var(--muted,#222)}
.plur1bus-desktop summary{cursor:pointer;padding:8px 0}.plur1bus-desktop .pb-review{padding:18px;border:1px solid var(--border,#555)}
.plur1bus-desktop .pb-check{display:flex;gap:10px;align-items:center;margin:12px 0}.plur1bus-desktop .pb-check input{display:inline-block}
.plur1bus-desktop{max-width:1080px;padding:28px 32px;--pb-line:var(--border,#3f4148);--pb-soft:var(--muted-foreground,#a9adb8);--pb-accent:var(--primary,#9692f5)}
.plur1bus-desktop h1{font-size:26px;letter-spacing:-.6px;margin:0}.plur1bus-desktop header p{color:var(--pb-soft);font-size:13px}
.plur1bus-desktop .pb-nav{display:flex;gap:6px;border-bottom:1px solid var(--pb-line);margin-bottom:24px;padding-bottom:10px;flex-wrap:wrap}
.plur1bus-desktop .pb-nav button{border:0;background:transparent;color:var(--pb-soft);padding:10px 14px}
.plur1bus-desktop .pb-nav button[aria-pressed=true]{color:var(--foreground);background:var(--muted,#26262e);box-shadow:inset 0 -2px var(--pb-accent)}
.plur1bus-desktop .pb-settings{border:0;padding:0}.plur1bus-desktop .pb-settings h2{font-size:20px;margin:0 0 6px}
.plur1bus-desktop .pb-intro{color:var(--pb-soft);max-width:70ch;font-size:13px;line-height:1.6}
.plur1bus-desktop .pb-setting-group{border-top:1px solid var(--pb-line);margin-top:24px}
.plur1bus-desktop .pb-setting-group summary{font-size:15px;font-weight:600;padding:18px 0}
.plur1bus-desktop .pb-setting-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,210px);gap:24px;align-items:center;padding:16px 0;border-top:1px solid var(--pb-line)}
.plur1bus-desktop .pb-setting-row:first-of-type{border-top:0}.plur1bus-desktop .pb-setting-row label{font-weight:550;font-size:14px}
.plur1bus-desktop .pb-setting-help{color:var(--pb-soft);font-size:12px;line-height:1.6;max-width:64ch;margin:5px 0 0}
.plur1bus-desktop .pb-setting-control{justify-self:end;width:100%;font-size:13px}
.plur1bus-desktop .pb-settings-search{display:block;max-width:420px;margin:20px 0 8px;font-size:13px;font-weight:550}
.plur1bus-desktop .pb-settings-search input{width:100%;margin-top:7px;font-weight:400}
.plur1bus-desktop .pb-health-watch{border-top:1px solid var(--pb-line);padding-top:18px}
.plur1bus-desktop .pb-health-list{list-style:none;padding:0;margin:12px 0}
.plur1bus-desktop .pb-health-list li{border-top:1px solid var(--pb-line);padding:12px 0}
.plur1bus-desktop .pb-health-list small{margin-top:4px}
.plur1bus-desktop .pb-toggle{display:flex;justify-content:flex-end;align-items:center;gap:10px;font-size:12px;color:var(--pb-soft)}
.plur1bus-desktop .pb-toggle input{appearance:none;width:36px;height:21px;padding:2px;border-radius:20px;background:var(--muted,#34343d);cursor:pointer;flex-shrink:0}
.plur1bus-desktop .pb-toggle input:before{content:'';display:block;width:15px;height:15px;border-radius:50%;background:var(--pb-soft)}
.plur1bus-desktop .pb-toggle input:checked{background:var(--pb-accent)}.plur1bus-desktop .pb-toggle input:checked:before{transform:translateX(14px);background:var(--background,#fff)}
.plur1bus-desktop .pb-setting-row :disabled{opacity:.48;cursor:not-allowed}
.plur1bus-desktop :is(button,input,select,summary):focus-visible{outline:2px solid var(--pb-accent);outline-offset:3px}
.plur1bus-desktop .pb-review{position:sticky;bottom:0;background:var(--background,#18181c);border-radius:8px;box-shadow:0 -4px 18px #0002;z-index:2}
.plur1bus-desktop .pb-setting-row .pb-review{position:static;grid-column:1/-1}
.plur1bus-desktop .pb-jev-key{grid-column:1/-1}
.plur1bus-desktop footer{margin-top:32px;padding:18px 0;border-top:1px solid var(--pb-line);font-size:12px;color:var(--pb-soft)}
@media(max-width:680px){.plur1bus-desktop{padding:20px 16px}.plur1bus-desktop .pb-setting-row{grid-template-columns:1fr;gap:10px}.plur1bus-desktop .pb-toggle{justify-content:flex-start}.plur1bus-desktop .pb-setting-control{justify-self:start}}
`;

/** Build a provider form target without carrying stale credentials/model options across providers.
 * @param {string} provider Selected supported backend.
 * @param {string} kind Embedding or reranker.
 * @returns {object} Explicit editable defaults, never an automatic model download.
 */
export function retrievalDefaults(provider, kind) {
  if (provider === 'disabled') return { provider };
  if (provider === 'local-onnx' && kind === 'reranker') return { provider, model: 'BAAI/bge-reranker-v2-m3',
    revision: '6f5ff65298512715a1e669753bc754d2bc8f367b', modelDir: '', localFilesOnly: true,
    maxTokens: 512, batchSize: 8 };
  if (provider === 'local-onnx') return { provider, model: 'jinaai/jina-embeddings-v5-text-nano-retrieval',
    revision: 'ac5d898c8d382b17167c33e5c8af644a3519b47d', dimensions: 768, modelDir: '',
    license: 'CC-BY-NC-4.0', licenseAccepted: false, queryPrefix: 'Query: ', passagePrefix: 'Document: ' };
  return { provider, model: '', ...(kind === 'embedding' ? { dimensions: 768 } : {}),
    ...(provider === 'local-transformers' ? { localFilesOnly: true } : { baseUrl: '', apiKeyEnv: '' }) };
}

async function writeFeatureSetting(request, settings, change) {
  const body = { identifier: change.identifier, value: change.value, revision: settings.revision };
  if (settings.settingsRpcWrite) return request.run('/desktop/settings', { method: 'PUT', body });
  let nonce = change.nonce;
  if (!nonce) {
    const preview = await request.run('/desktop/settings/preview', { method: 'POST', body });
    if (preview.stale || preview.error) return preview;
    nonce = preview.value.nonce;
  }
  return request.run('/desktop/settings', { method: 'POST', body: { ...body, nonce } });
}

function JevKeySettings({ settings }) {
  const credentials = settings.jevCredentials;
  return h('div', { className: 'pb-jev-key' },
    h('h3', null, tr('Jev API key', 'Jev-API-Schlüssel')),
    h('p', null, credentials.configured ? tr('A key is configured.', 'Ein Schlüssel ist hinterlegt.') : tr('No key is configured.', 'Kein Schlüssel hinterlegt.')),
    h('p', null, credentials.editable
      ? tr('Save the key in Hermes Settings → Memory → PLUR1BUS. Then select Automatic (Jev) here to send eligible captures to api.typesafe.ai.',
           'Hinterlege den Schlüssel unter Hermes-Einstellungen → Gedächtnis → PLUR1BUS. Wähle dann hier Automatisch (Jev), um geeignete Texte an api.typesafe.ai zu senden.')
      : tr('This profile uses a separately configured credential source.', 'Dieses Profil verwendet eine separat konfigurierte Schlüsselquelle.')));
}

function FeatureSettings({ rest }) {
  const language = locale();
  const request = useRequests(rest);
  const [settings, setSettings] = React.useState(null), [review, setReview] = React.useState(null);
  const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
  const [search, setSearch] = React.useState('');
  React.useEffect(() => { setSettings(null); setReview(null); setNotice(''); void load(); }, [rest, language]);
  async function load() {
    setBusy(true); setReview(null);
    const result = await request.current?.run('/desktop/settings?language=' + language);
    setBusy(false);
    if (!result || result.stale) return;
    if (result.error) setNotice(tr("Settings are unavailable.", "Einstellungen sind nicht verfügbar."));
    else {
      setSettings(result.value);
      return result.value;
    }
  }
  async function preview(identifier, value) {
    if (!settings || settings.readOnly || busy) return;
    setNotice('');
    if (settings.settingsRpcWrite) {
      setReview({ identifier, value, revision: settings.revision });
      return;
    }
    setBusy(true); setReview(null);
    const result = await request.current?.run('/desktop/settings/preview', { method: 'POST',
      body: { identifier, value, revision: settings.revision } });
    setBusy(false);
    if (!result || result.stale) return;
    if (result.error) setNotice(tr("Reload settings and review the change again.", "Bitte Einstellungen neu laden und erneut prüfen."));
    else setReview(result.value);
  }
  async function save() {
    if (!review || busy) return;
    setBusy(true);
    const body = { identifier: review.identifier, value: review.value, revision: review.revision };
    const result = request.current && await writeFeatureSetting(request.current, settings, review);
    setBusy(false); setReview(null);
    if (!result || result.stale) return;
    if (result.error) {
      setNotice(tr("Could not save. Reload settings and review the change again.", "Speichern abgelehnt. Bitte die Werte neu laden und die Änderung erneut prüfen."));
      return;
    }
    const latest = await load();
    if (latest) setNotice(latest.settings?.find(item => item.id === body.identifier)?.value === body.value
      ? tr("Saved. Restart the Hermes gateway to apply.", "Gespeichert. Hermes-Gateway zum Aktivieren neu starten.")
      : tr("The new value could not be confirmed after reloading.", "Der neue Wert konnte beim Neuladen nicht bestätigt werden."));
  }
  const normalizedSearch = search.trim().toLocaleLowerCase(locale());
  const visibleSettings = (settings?.settings || []).filter(setting =>
    !normalizedSearch || [setting.label, setting.id, setting.description, setting.group]
      .some(value => String(value || '').toLocaleLowerCase(locale()).includes(normalizedSearch)));
  const visibleGroups = [...new Set(visibleSettings.map(setting => setting.group || 'Features'))];
  return h('section', { className: 'pb-settings' }, h('h2', null, tr("How your memory works", "So arbeitet dein Gedächtnis")),
    h('p', { className: 'pb-intro' }, settings?.readOnly
      ? tr("This connection allows read access. To edit settings, open this profile as the backend's launch profile.", "Lesend geöffnet. Hermes bestätigt den Zugriff auf dieses Profil, übermittelt aber keine Identität für Schreibfreigaben. Für Änderungen das Profil als Backend-Startprofil öffnen.")
      : tr("These settings apply to the active profile. Review and confirm changes, then restart the gateway to apply them.", "Diese Einstellungen gelten nur für das aktive Profil. Änderungen werden zuerst zur Prüfung angezeigt und erst nach deiner Bestätigung gespeichert. Zum Aktivieren ist ein Gateway-Neustart nötig.")),
    h('button', { disabled: busy, onClick: () => { void load(); } }, busy ? tr("Loading…", "Lädt…") : tr("Reload settings", "Werte neu laden")),
    h('label', { className: 'pb-settings-search' }, tr("Search settings", "Einstellungen suchen"),
      h('input', { type: 'search', value: search, placeholder: tr("Name, description or setting ID", "Name, Beschreibung oder Einstellungs-ID"),
        onChange: event => setSearch(event.target.value), 'aria-label': tr("Search settings", "Einstellungen suchen") })),
    notice ? h('p', { role: 'status' }, notice) : null,
    ...visibleGroups.map(group =>
      h('details', { key: group, className: 'pb-setting-group', open: group === tr("Storage", "Speicherung") }, h('summary', null, group),
      ...visibleSettings.filter(setting => (setting.group || 'Features') === group).map(setting => h('div', { key: setting.id, className: 'pb-setting-row' },
      h('div', null, h('label', { htmlFor: `pb-${setting.id}` }, setting.label || setting.id),
        h('p', { id: `pb-help-${setting.id}`, className: 'pb-setting-help' }, setting.description || tr("Setting for the active profile.", "Einstellung des aktiven Profils."))),
      typeof setting.value === 'boolean' ? h('div', { className: 'pb-toggle' }, setting.value ? tr("On", "An") : tr("Off", "Aus"),
        h('input', { id: `pb-${setting.id}`, type: 'checkbox', role: 'switch', checked: setting.value, disabled: busy || settings.readOnly,
          'aria-describedby': `pb-help-${setting.id}`, onChange: event => { void preview(setting.id, event.target.checked); } })) :
      Number.isInteger(setting.minimum) ? h('div', null, h('output', { htmlFor: `pb-${setting.id}` },
        `${new Intl.NumberFormat(locale()).format(setting.value)}${setting.unit ? ` ${setting.unit}` : ''}`), h('input', { id: `pb-${setting.id}`, className: 'pb-setting-control', type: 'range',
        min: setting.minimum, max: setting.maximum, step: 1, value: setting.value, disabled: busy || settings.readOnly,
        'aria-valuetext': String(setting.value), 'aria-describedby': `pb-help-${setting.id}`,
        onChange: event => { void preview(setting.id, Number(event.target.value)); } })) :
      h('select', { id: `pb-${setting.id}`, className: 'pb-setting-control', 'aria-describedby': `pb-help-${setting.id}`, disabled: busy || settings.readOnly, value: String(setting.choices.indexOf(setting.value)),
        onChange: event => { void preview(setting.id, setting.choices[Number(event.target.value)]); } },
      setting.choices.map((value, index) => h('option', { key: index, value: String(index) }, value === '' ? tr("Inherit default", "Standard erben") : setting.choiceLabels?.[value] || String(value)))),
      setting.id === 'capture.mode' && settings.jevCredentials
        ? h(JevKeySettings, { settings })
        : null,
      review?.identifier === setting.id ? h('div', { className: 'pb-review', role: 'region', 'aria-label': tr("Review change", "Änderung prüfen") },
        h('h3', null, tr("Review change", "Änderung prüfen")), h('p', null, `${setting.label || setting.id}: ${review.value === true ? tr("Enable", "Aktivieren") : review.value === false ? tr("Disable", "Deaktivieren") : setting.choiceLabels?.[review.value] || (review.value === '' ? tr("Inherit default", "Standard erben") : String(review.value))}`),
        h('p', { className: 'pb-intro' }, tr("Applies to this profile. Restart its gateway after saving.", "Gilt für dieses Profil. Nach dem Speichern ist ein Gateway-Neustart erforderlich.")),
        h('button', { disabled: busy, onClick: () => setReview(null) }, tr("Cancel", "Abbrechen")),
        h('button', { disabled: busy, onClick: () => { void save(); } }, tr("Confirm save", "Speichern bestätigen"))) : null)))),
    settings && visibleSettings.length === 0 ? h('p', { role: 'status' }, normalizedSearch ? tr("No matching settings.", "Keine passenden Einstellungen gefunden.") : tr("No settings available.", "Keine Einstellungen verfügbar.")) : null);
}

function RetrievalSettings({ rest }) {
  const request = useRequests(rest);
  const [settings, setSettings] = React.useState(null);
  const [kind, setKind] = React.useState('embedding');
  const [target, setTarget] = React.useState({});
  const [review, setReview] = React.useState(null);
  const [approved, setApproved] = React.useState(false);
  const [job, setJob] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const jobRef = React.useRef(null);
  const sequence = React.useRef(0);
  React.useEffect(() => {
    let disposed = false;
    let polling = false;
    async function poll() {
      if (!jobRef.current || disposed || polling) return;
      polling = true;
      const id = jobRef.current;
      const result = await request.current?.run(`/desktop/retrieval/jobs/${encodeURIComponent(id)}`);
      polling = false;
      if (disposed || !result || result.stale) return;
      if (result.error) { setError(tr("Job status unavailable. Check its status again before starting another job.", "Auftragsstatus nicht erreichbar. Nicht erneut starten; Status erneut abfragen.")); return; }
      setJob({ id, ...result.value });
      if (['done', 'failed'].includes(result.value.status)) { jobRef.current = null; setBusy(false); }
    }
    const timer = setInterval(() => { void poll(); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [rest]);
  function edit(next) { sequence.current++; setTarget(next); setReview(null); setApproved(false); setError(''); }
  async function load() {
    setBusy(true); setError('');
    // useRequests installs its gate after the initial commit.  A click in that
    // small window must remain retryable rather than leaving this button busy.
    const gate = request.current;
    if (!gate) {
      setBusy(false);
      setError(tr("Provider settings are still loading. Try again shortly.", "Provider-Einstellungen werden noch initialisiert. Bitte erneut versuchen."));
      return;
    }
    const result = await gate.run('/desktop/retrieval');
    if (!result || result.stale) { setBusy(false); return; }
    setBusy(false);
    if (result.error) setError(tr("Provider settings unavailable. Update the backend or check the connection.", "Provider-Einstellungen nicht erreichbar. Backend aktualisieren oder Verbindung prüfen."));
    else {
      setSettings(result.value); setKind('embedding'); edit(result.value.embedding);
      if (result.value.readOnly) return;
      const recent = await request.current?.run('/desktop/retrieval/jobs');
      if (!recent || recent.stale) return;
      if (recent.error) { setError(tr("Job status unavailable. Reload it before making changes.", "Auftragsstatus nicht erreichbar. Vor neuen Änderungen erneut laden.")); setSettings(null); return; }
      const latest = recent.value.jobs?.[0];
      if (latest) {
        setJob(latest);
        if (['queued', 'running'].includes(latest.status)) { jobRef.current = latest.id; setBusy(true); }
      }
    }
  }
  async function preview(action = kind) {
    if (settings?.readOnly) return;
    const current = ++sequence.current;
    setBusy(true); setError(''); setReview(null); setApproved(false);
    const result = await request.current?.run('/desktop/retrieval/preview', { method: 'POST',
      body: { kind: action, ...(action === 'activate' ? { job: job.id } : { target }) } });
    if (!result || result.stale || current !== sequence.current) return;
    setBusy(false);
    if (result.error) setError(tr("Preview unavailable. Check the model, dimensions, license and source partition.", "Vorschau nicht möglich. Modell, Dimensionen, Lizenz und vorhandene Quellpartition prüfen. Es wurde nichts umgestellt."));
    else setReview(result.value);
  }
  async function commit() {
    if (settings?.readOnly || !review || !approved || busy) return;
    setBusy(true); setError('');
    const result = await request.current?.run('/desktop/retrieval/commit', { method: 'POST',
      body: { nonce: review.nonce, confirmation: review.kind } });
    if (!result || result.stale) return;
    setReview(null); setApproved(false);
    if (result.error) { setBusy(false); setError(tr("The confirmation failed or its response was lost. Check the job status before trying again.", "Bestätigung nicht übernommen oder Antwort verloren. Keine automatische Wiederholung. Vor neuem Versuch den Auftragsstatus prüfen.")); }
    else { jobRef.current = result.value.job; setJob({ id: result.value.job, status: 'queued' }); }
  }
  const textField = (key, label, required = false) => h('label', { key }, label,
    h('input', { value: target[key] || '', maxLength: 2048, required, disabled: busy,
      onChange: event => { const next = { ...target }; if (event.target.value) next[key] = event.target.value; else delete next[key]; edit(next); } }));
  const providers = settings?.[kind === 'embedding' ? 'embeddingProviders' : 'rerankerProviders'] || [];
  return h('section', null, h('h2', null, tr('Providers & Dimensions', 'Provider & Dimensionen')),
    h('p', null, settings?.readOnly
      ? tr("This connection is read-only. Open the profile as the backend's launch profile to change providers or migrate dimensions.", "Diese Backend-Route erlaubt nur lesenden Zugriff. Für Provider-Wechsel und Dimensionsmigration das Profil als Backend-Startprofil öffnen.")
      : tr("Change the embedding provider, configure reranking, or re-embed memories with a different dimension for this profile.", "Embedding-Provider wechseln, Reranking konfigurieren oder Erinnerungen in neue Dimensionen umbetten. Gilt ausschließlich für dieses Profil.")),
    h('button', { disabled: busy, onClick: () => { void load(); } }, settings ? tr("Reload settings", "Einstellungen neu laden") : tr("Open provider settings", "Provider-Einstellungen öffnen")),
    settings && !settings.readOnly ? h('form', { onSubmit: event => { event.preventDefault(); void preview(); } },
      h('div', { className: 'pb-actions' },
        h('label', null, tr("Area", "Bereich"), h('select', { value: kind, disabled: busy, onChange: event => {
          setKind(event.target.value); edit(settings[event.target.value]);
        } }, h('option', { value: 'embedding' }, tr('Embeddings / Dimensions', 'Embeddings / Dimensionen')), h('option', { value: 'reranker' }, 'Reranking'))),
        h('label', null, 'Ziel-Provider', h('select', { value: target.provider || '', disabled: busy,
          onChange: event => edit(event.target.value === settings[kind].provider ? { ...settings[kind] }
            : retrievalDefaults(event.target.value, kind)) }, providers.map(value => h('option', { key: value, value }, value)))),
        target.provider !== 'disabled' ? textField('model', 'Ziel-Modell', true) : null,
        kind === 'embedding' ? h('label', null, 'Ziel-Dimensionen', h('input', { type: 'number', min: 1, max: 8192,
          required: true, value: target.dimensions || '', disabled: busy,
          onChange: event => edit({ ...target, dimensions: Number(event.target.value) }) })) : null),
      target.provider === 'local-onnx' ? h(React.Fragment, null,
        h('div', { className: 'pb-actions' }, textField('modelDir', tr("Existing model folder", "Vorhandener Modellordner"), true)),
        kind === 'embedding' ? h(React.Fragment, null,
          h('p', null, tr("Jina v5 Nano supports 32, 64, 128, 256, 512 and 768 dimensions. Vectors are recomputed from the original text. The model must already be installed.", "Jina v5 Nano unterstützt 32, 64, 128, 256, 512 und 768 Dimensionen. Vektoren werden aus den Originaltexten neu berechnet. Kein automatischer Modelldownload.")),
          h('label', { className: 'pb-check' }, h('input', { type: 'checkbox', checked: target.licenseAccepted === true, disabled: busy,
            onChange: event => edit({ ...target, licenseAccepted: event.target.checked }) }), tr("Accept CC-BY-NC-4.0 for this model (non-commercial use).", "CC-BY-NC-4.0 für dieses Modell akzeptieren (keine kommerzielle Nutzung).")))
          : h('p', null, tr("Prepare the checksum-verified, quantized BGE v2-m3 CPU ONNX model. Recall uses the installed model.", "BGE v2-m3 wird als byte-geprüftes, quantisiertes CPU-ONNX-Modell vorbereitet. Es gibt keinen Download während eines Recall-Aufrufs."))) : null,
      ['openai-compatible', 'omlx', 'cohere'].includes(target.provider) ? h('div', { className: 'pb-actions' },
        target.provider !== 'cohere' ? textField('baseUrl', 'API-Basis-URL', target.provider === 'openai-compatible') : null,
        textField('apiKeyEnv', tr("API key environment variable", "API-Key: Name der Umgebungsvariable"))) : null,
      target.provider === 'local-transformers' ? h('div', { className: 'pb-actions' }, textField('revision', 'Modell-Revision (optional)'),
        textField('cacheDir', 'Modell-Cache (optional)')) : null,
      h('p', null, tr("Stop the gateway and other processes using this memory store before running the job. Hermes Desktop can stay open.", "Vor Ausführung müssen Gateway und andere Memory-Laufzeiten dieses Speichers gestoppt sein. Hermes Desktop kann offen bleiben. Es werden keine Prozesse automatisch beendet.")),
      h('p', null, kind === 'embedding' ? tr("The existing store is preserved. Preview, back up and convert, verify, then activate separately.", "Der bestehende Speicher bleibt erhalten. Ablauf: Vorschau, Backup & Umrechnung, Prüfung, separate Aktivierung.")
        : tr("Reranking changes preserve the current vectors. The profile configuration is backed up. Restart the memory runtime to apply.", "Reranking benötigt keine Vektormigration. Die Profilkonfiguration wird gesichert; die Änderung gilt nach Neustart der Memory-Laufzeit.")),
      h('button', { type: 'submit', disabled: busy }, tr("Review change", "Änderung prüfen")),
      kind === 'reranker' && target.provider === 'local-onnx'
        ? h('button', { type: 'button', disabled: busy, onClick: () => { void preview('reranker-prepare'); } }, tr("Prepare BGE model", "BGE-Modell vorbereiten")) : null) : null,
    error ? h('p', { role: 'alert' }, error) : null,
    review ? h('div', { className: 'pb-review' }, h('h3', null, tr("Confirm change", "Änderung bestätigen")),
      h('p', null, `Profil ${review.profile} · Agent ${review.agentId} · ${review.target.provider} · ${review.target.model || 'deaktiviert'}`),
      review.cards != null ? h('p', null, `${review.cards} Erinnerungen → ${review.target.dimensions} Dimensionen`) : null,
      review.externalData ? h('p', { role: 'alert' }, tr("This provider receives memory text over its API. Check the endpoint and potential costs before confirming.", "Achtung: Dieser Provider erhält Erinnerungstexte über seine API. Prüfe den Endpoint und mögliche Kosten vor der Bestätigung.")) : null,
      h('label', { className: 'pb-check' }, h('input', { type: 'checkbox', checked: approved, disabled: busy,
        onChange: event => setApproved(event.target.checked) }), tr("I have reviewed the target and profile and confirm the change.", "Ich habe Ziel und Profil geprüft und bestätige diese Änderung.")),
      h('button', { disabled: busy || !approved, onClick: () => { void commit(); } },
        review.kind === 'activate' ? tr("Activate verified store", "Geprüften Speicher aktivieren") : review.kind === 'embedding' ? tr("Start backup and conversion", "Backup & Umrechnung starten")
          : review.kind === 'reranker-prepare' ? tr("Prepare BGE model", "BGE-Modell vorbereiten") : tr("Save reranking", "Reranking speichern"))) : null,
    job ? h('div', { role: 'status' },
      h('p', null, `Auftrag: ${job.status}${job.progress ? ` · ${job.progress.cursor}/${job.progress.cards}` : ''}`),
      job.status === 'failed' ? h('p', { role: 'alert' }, job.error === 'runtime_active'
        ? tr("A memory process is still running. Stop the gateway, then review and confirm again.", "Eine Memory-Laufzeit ist noch aktiv. Gateway beenden, anschließend neu prüfen und bestätigen.")
        : tr("The job failed and the source was preserved. Check model availability and source changes before retrying.", "Auftrag fehlgeschlagen. Quelle bleibt erhalten; Modellverfügbarkeit und Quelländerungen prüfen. Keine automatische Wiederholung.")) : null,
      job.result?.validated ? h(React.Fragment, null, h('p', null, tr("Backup created. The new vectors and metadata were verified and await activation.", "Backup vorhanden. Neue Vektoren und unveränderte Metadaten geprüft; noch nicht aktiv.")),
        h('button', { disabled: busy, onClick: () => { void preview('activate'); } }, tr("Review activation", "Aktivierung prüfen"))) : null,
      job.result?.modelProbePassed ? h('p', null, tr("The BGE model passed checksum verification and a test. You can now select it in the reranker configuration.", "BGE-Modell byte-geprüft und getestet; die aktive Reranker-Konfiguration blieb unverändert.")) : null,
      job.result?.restartRequired ? h('p', null, tr("Saved. Restart the memory runtime and refresh status.", "Gespeichert. Memory-Laufzeit jetzt neu starten und anschließend den Status aktualisieren.")) : null) : null);
}

function Partition({ rest, profile, sdkRest }) {
  useLocale('plur1bus');
  const [panel, setPanel] = React.useState('settings');
  const [view, setView] = React.useState({ loading: true, status: null, proposals: [], error: '', workshopError: '' });
  const reader = React.useRef(null);
  React.useEffect(() => {
    const current = createScopedReader(rest, scopeKey, setView);
    reader.current = current;
    void current.load();
    return () => { current.dispose(); reader.current = null; };
  }, [rest]);
  const s = view.status, embedding = s?.embedding || {}, reranker = s?.reranker || {};
  return h('main', { className: 'plur1bus-desktop' },
    h('style', null, css),
    h('header', null, h('div', null, h('h1', null, 'PLUR1BUS'),
      h('p', null, tr("Active Hermes profile: {0}", "Aktives Hermes-Profil: {0}", profile || 'default'))),
    h('button', { type: 'button', disabled: view.loading, onClick: () => { void reader.current?.load(); } },
      view.loading ? tr("Loading…", "Wird geladen…") : tr("Refresh", "Aktualisieren"))),
    view.error ? h('p', { role: 'alert', className: 'pb-error' }, view.error) : null,
    h('nav', { className: 'pb-nav', 'aria-label': 'PLUR1BUS-Bereiche' },
      ...[['settings', tr("Settings", "Einstellungen")], ['models', tr("Models & Storage", "Modelle & Speicher")], ['memories', tr("Memories", "Erinnerungen")], ['diagnostics', tr("Diagnostics", "Diagnose")]].map(([id, label]) =>
        h('button', { key: id, type: 'button', 'aria-pressed': panel === id, onClick: () => setPanel(id) }, label))),
    panel === 'diagnostics' ? h(HostCompatibility, { key: scopeKey(), rest: sdkRest }) : null,
    view.loading ? h('p', { role: 'status' }, tr("Reading the active memory partition…", "Aktive Memory-Partition wird gelesen…")) : null,
    s && panel === 'diagnostics' ? h(React.Fragment, null,
      h('p', { role: 'status' }, s.configured && s.storage?.status === 'ready'
        ? tr("Memory partition is configured and reachable.", "Memory-Partition konfiguriert und erreichbar.") : tr("The memory partition needs attention.", "Memory-Partition benötigt Aufmerksamkeit.")),
      h('div', { className: 'pb-grid' },
        h('section', null, h('h2', null, 'Memory-Partition'), h('dl', null,
          field('Agent', s.agentId), field('Scope', s.scopeType), field(tr("Records", "Datensätze"), s.storage?.cards))),
        h('section', null, h('h2', null, tr("Main agent cards · active profile", "Karten des Hauptagenten · aktives Profil")),
          h('p', null, tr("Private cards in the selected profile.", "Private Karten dieses Profils. Andere Profile und Subagenten werden nicht ausgelesen.")),
          ...primaryAgentRows(s).map(row => h('dl', { key: row.id },
            field(tr("Profile", "Profil"), row.profile), field('Agent', row.id), field(tr("Cards", "Karten"), row.cards))),
          !primaryAgentRows(s).length ? h('p', null, tr("The private card count is unavailable.", "Keine private Hauptagenten-Zählung verfügbar.")) : null),
        h('section', null, h('h2', null, 'Embeddings'), h('dl', null,
          field('Provider', embedding.provider), field(tr("Model", "Modell"), embedding.model), field(tr("Dimensions", "Dimensionen"), embedding.dimensions))),
        h('section', null, h('h2', null, 'Reranking'), h('dl', null,
          field('Provider', reranker.provider), field(tr("Model", "Modell"), reranker.model))),
        s.jevCredentials ? h('section', null, h('h2', null, tr('Jev · Storage mode', 'Jev · Speicherweise')),
          h('p', null, tr("Used only for automatic storage mode. Only the key status is displayed.", "Nur relevant für die automatische Speicherweise. Schlüsselwerte werden nicht angezeigt.")),
          h('dl', null, field(tr("Key", "Schlüssel"), s.jevCredentials.configured === true ? tr("Configured", "Vorhanden") : tr("Missing", "Fehlt")),
            field(tr("Source", "Quelle"), s.jevCredentials.source === 'configured_environment' ? tr("Configured environment variable", "Konfigurierte Umgebungsvariable") : tr("Default environment variable", "Standard-Umgebungsvariable")))) : null),
      h(HealthWatch, { status: s })) : null,
    s && panel === 'models' ? h(React.Fragment, null,
      h('p', { className: 'pb-intro' }, `Embeddings: ${embedding.model || tr("Not configured", "Nicht konfiguriert")} (${embedding.dimensions || '—'} Dimensionen). Reranking: ${reranker.model || tr("Not configured", "Nicht konfiguriert")}.`),
      h(RetrievalSettings, { rest })) : null,
    s && panel === 'settings' ? h(FeatureSettings, { rest }) : null,
    s && panel === 'memories' ? h(MemoryBrowser, { rest }) : null,
    s && panel === 'memories' ? h(Obsidian, { rest, refresh: () => { void reader.current?.load(); } }) : null,
    s && panel === 'memories' ? h(Workshop, { rest, proposals: view.proposals, error: view.workshopError, loading: view.loading,
      refresh: () => { void reader.current?.load(); } }) : null,
    h('footer', { 'aria-label': 'PLUR1BUS-Version' }, s?.version ? `PLUR1BUS ${s.version} · Hermes` : tr("PLUR1BUS · Version unavailable", "PLUR1BUS · Version nicht verfügbar")));
}

/** Keep navigation scoped to authoritative activation; stale probes cannot change another profile.
 * @param {Function} probe Read current profile's activation, or null on transient failure.
 * @param {Function} current Connection/profile identity.
 * @param {Function} show Set navigation visibility.
 * @returns {object} Refreshable, disposable visibility controller.
 */
export function createNavigationVisibility(probe, current, show) {
  const known = new Map();
  let sequence = 0, disposed = false, owner;
  return {
    async refresh() {
      if (disposed) return;
      const identity = current(), turn = ++sequence;
      // Unknown is not an activation grant: never surface memory navigation
      // until this exact connection/profile has verified `enabled: true`.
      // A cached true is retained only for that same identity during a
      // transient probe failure; profile changes immediately fail closed.
      if (owner !== identity) { owner = identity; show(known.get(identity) === true); }
      let enabled;
      try { enabled = await probe(); } catch { enabled = null; }
      if (disposed || turn !== sequence || current() !== identity) return;
      if (typeof enabled === 'boolean') known.set(identity, enabled);
      // A temporary connection failure must not erase a verified menu entry.
      show(known.get(identity) === true);
    },
    dispose() { disposed = true; sequence++; show(false); },
  };
}

/** Register native navigation without changing backend configuration or memory data. */
export default {
  id: 'plur1bus',
  name: 'PLUR1BUS',
  description: tr("Memory browser, embedding and reranker status, and reviewed Skill Workshop actions for the active Hermes profile.", "Memory-Browser, Embedding-/Reranker-Status und geprüfte Skill-Workshop-Aktionen im aktiven Hermes-Profil."),
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n?.register({ en: { language: 'en' }, de: { language: 'de' } });
    translateLocale = ctx.i18n?.t;
    ctx.onDispose(() => { translateLocale = undefined; });
    function Page() {
      const profile = useValue(host.state.profile);
      const connection = useValue(host.state.connectionId);
      const identity = JSON.stringify([connection, profile]);
      const rest = React.useMemo(() => createProfileTransport(
        ctx.rest, host, { connection, profile }, scopeKey, identity), [connection, profile]);
      return h(Partition, { key: identity, rest, profile, sdkRest: ctx.rest });
    }
    let closeWorkspace = null;
    const routeNavigation = Boolean(ROUTES_AREA && typeof host.navigate === 'function');
    const workspaceNavigation = typeof host.openWorkspace === 'function';
    const supported = routeNavigation || workspaceNavigation;
    const open = () => {
      if (routeNavigation) { host.navigate('/plur1bus'); return; }
      if (!workspaceNavigation) return;
      closeWorkspace = host.openWorkspace('plur1bus', { title: 'PLUR1BUS', render: () => h(Page),
        onClose: () => { closeWorkspace = null; } });
    };
    ctx.onDispose(() => { closeWorkspace?.(); closeWorkspace = null; });
    // Always discoverable even when a broken bridge prevents activation probes.
    // This is a diagnostic command, not an enabled-profile memory entry.
    let closeHelp = null;
    const removeHelp = ctx.registerMany([{ id: 'host-check', area: PALETTE_AREA,
      data: { id: 'plur1bus.host-check', label: tr("PLUR1BUS: Check Desktop compatibility", "PLUR1BUS: Desktop-Kompatibilität prüfen"), run: () => {
        if (workspaceNavigation) closeHelp = host.openWorkspace('plur1bus-host-check', {
          title: tr("PLUR1BUS compatibility", "PLUR1BUS-Kompatibilität"), render: () => h(HostCompatibility, { key: scopeKey(), rest: ctx.rest }) });
        else if (routeNavigation) {
          host.navigate('/plur1bus');
          host.notify?.({ kind: 'info', message: tr("Open Diagnostics to check compatibility.", "Die Kompatibilitätsprüfung findest du im Bereich Diagnose.") });
        } else host.notify?.({ kind: 'error', message: tr("Hermes navigation is unavailable. PLUR1BUS will appear in the status bar and command palette when navigation is ready.", "Hermes-Navigation ist nicht verfügbar. PLUR1BUS lässt sich über den Status- oder Befehlspaletten-Eintrag öffnen, sobald die Host-Navigation verfügbar ist.") });
      } } }]);
    ctx.onDispose(() => { removeHelp(); closeHelp?.(); });
    // Current Hermes sidebar navigation requires an actual route and path.
    // Older hosts retain the workspace callback when route contributions are absent.
    if (ROUTES_AREA) {
      const removeRoute = ctx.registerMany([{ id: 'page', area: ROUTES_AREA,
        data: { path: '/plur1bus' }, render: () => h(Page) }]);
      ctx.onDispose(() => { removeRoute(); });
    }
    let removeNavigation = null;
    const notified = new Set();
    const visibility = createNavigationVisibility(async () => {
      const report = await checkDesktopCompatibility(host, ctx.rest, scopeKey);
      if (report.status === 'stale') return null;
      if (report.status === 'unsupported' && !notified.has(report.identity)) {
        notified.add(report.identity);
        host.notify?.({ kind: 'error', message: report.message });
      }
      return report.enabled;
    }, scopeKey, enabled => {
      if (!enabled) { removeNavigation?.(); removeNavigation = null; return; }
      if (removeNavigation) return;
      removeNavigation = ctx.registerMany([
      ...(SIDEBAR_NAV_AREA ? [{ id: 'sidebar-open', area: SIDEBAR_NAV_AREA, order: 55,
        data: { codicon: 'database', label: 'PLUR1BUS',
          ...(ROUTES_AREA ? { path: '/plur1bus' } : { onSelect: open }) } }] : []),
      { id: 'open-button', area: STATUSBAR_AREAS.left, order: 55,
        data: { id: 'plur1bus-open', variant: 'action', label: 'PLUR1BUS', disabled: !supported, onSelect: open,
          title: supported ? tr("Open PLUR1BUS", "PLUR1BUS öffnen") : tr("Hermes Desktop navigation or workspace support is required", "Hermes Desktop mit Navigation oder Workspace-Unterstützung erforderlich") } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'plur1bus.open', label: tr("Open PLUR1BUS", "PLUR1BUS öffnen"),
        keywords: ['memory', 'embeddings', 'reranker', 'plur1bus'], run: open } },
      ]);
    });
    const refresh = () => { void visibility.refresh(); };
    const unsubscribers = [host.state.profile, host.state.connectionId].map(state => state.subscribe(refresh));
    const timer = setInterval(refresh, 15000);
    if (typeof window !== 'undefined') window.addEventListener('focus', refresh);
    ctx.onDispose(() => {
      unsubscribers.forEach(unsubscribe => unsubscribe()); clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('focus', refresh);
      visibility.dispose();
    });
  },
};
