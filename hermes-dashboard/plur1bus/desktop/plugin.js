import React from 'react';
import * as sdk from '@hermes/plugin-sdk';
// Optional newer exports must not prevent the diagnostic/fallback from loading.
const { host, useValue, STATUSBAR_AREAS, PALETTE_AREA, SIDEBAR_NAV_AREA } = sdk;

/** Read-only startup check; source patch presence is never inferred from an API name.
 * @param {object} runtime Hermes SDK host.
 * @param {object} bridge Electron renderer bridge.
 * @param {Function} current Current profile/connection identity.
 * @returns {Promise<object>} Safe capability report, without memory reads or writes.
 */
export async function checkDesktopCompatibility(runtime, bridge, current) {
  const identity = current();
  const [connection, profile] = JSON.parse(identity);
  const missing = [];
  if (typeof runtime.openWorkspace !== 'function') missing.push('Workspace-API');
  if (typeof runtime.profileRoutes !== 'function') missing.push('Profilrouting-API');
  if (typeof bridge?.api !== 'function') missing.push('Electron-API');
  const base = { identity, sidebar: 'unknown', profileBinding: false, enabled: null };
  if (missing.length) return { ...base, status: 'unsupported',
    message: `Hermes Desktop benötigt ein Update: ${missing.join(', ')} fehlt. Es wurde nichts verändert.` };
  try {
    const rest = createProfileTransport(bridge.api, runtime.profileRoutes, { connection, profile }, current, identity);
    const caps = await rest('/desktop/capabilities');
    if (current() !== identity) return { ...base, status: 'stale' };
    return { ...base, profileBinding: true, enabled: typeof caps.memoryProviderEnabled === 'boolean' ? caps.memoryProviderEnabled : null,
      status: 'verified', message: 'Workspace und Profilverbindung geprüft. Die Sidebar-Erweiterung ist über die Host-API nicht nachweisbar; Statusleiste und Befehlspalette benötigen sie nicht.' };
  } catch (error) {
    return { ...base, status: current() !== identity ? 'stale' : 'blocked',
      enabled: error?.plur1busDisabled ? false : null,
      message: error?.plur1busReason || 'Profilverbindung nicht bestätigt. Datenzugriff bleibt gesperrt.' };
  }
}

function HostCompatibility() {
  const [report, setReport] = React.useState(null);
  const profile = useValue(host.state.profile), connection = useValue(host.state.connectionId);
  React.useEffect(() => {
    let disposed = false;
    setReport(null);
    const identity = scopeKey();
    async function check() {
      const result = await checkDesktopCompatibility(host, typeof window !== 'undefined' && window.hermesDesktop, scopeKey);
      if (!disposed && scopeKey() === identity && result.status !== 'stale') setReport(result);
    }
    void check();
    return () => { disposed = true; };
  }, [profile, connection]);
  return h('section', null, h('h2', null, 'Hermes-Kompatibilität'),
    h('p', { role: 'status' }, report?.message || 'Host-Funktionen und Profilzuordnung werden schreibgeschützt geprüft…'),
    h('p', null, 'Fehlt der linke Knopf: PLUR1BUS über die untere Statusleiste oder Befehlspalette öffnen. Bei nicht bestätigter Profilverbindung bleiben Daten und Aktionen gesperrt.'),
    h('details', null, h('summary', null, 'Quellinstallation automatisch vorbereiten'),
      h('p', null, 'Im PLUR1BUS-Paket ausführen (Python ≥ 3.12). Zuerst den ausgegebenen Plan prüfen; nur dessen exakter Bestätigungscode erlaubt den Neubau einer separaten Kopie.'),
      h('pre', null, 'python3 scripts/hermes-desktop-host.py --source /absoluter/pfad/hermes-agent\npython3 scripts/hermes-desktop-host.py --source /absoluter/pfad/hermes-agent --apply --confirm BESTAETIGUNGSCODE'),
      h('p', null, 'Alternativ nach Installation: <Hermes-Home>/bin/plur1bus-desktop-host.py. Kein Patchen bei jedem Start. Bestehende App, Profile und Memory bleiben unverändert.')));
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
          || 'Status nicht erreichbar. Prüfe, ob PLUR1BUS im aktiven Hermes-Profil aktiviert ist.') : '',
        workshopError: workshop.status === 'rejected' ? 'Workshop-Übersicht derzeit nicht verfügbar.' : '',
      });
    },
    dispose() { disposed = true; sequence++; },
  };
}

const h = React.createElement;
const scopeKey = () => JSON.stringify([host.state.connectionId.get(), host.state.profile.get()]);

/** Pin each request to a verified host-owned profile route, never ambient REST state.
 * @param {Function} api Electron's authenticated HermesApiRequest bridge.
 * @param {Function} routes Public host.profileRoutes inventory.
 * @param {object} owner Mounted connection and profile.
 * @param {Function} current Current UI identity.
 * @param {string} identity Mounted UI identity.
 * @returns {Function} Profile-bound plugin REST transport.
 */
export function createProfileTransport(api, routes, owner, current, identity) {
  const unavailable = message => Object.assign(new Error(message), { plur1busReason: message });
  const bounded = async operation => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(unavailable('Die Profilverbindung antwortet nicht rechtzeitig. Bitte erneut versuchen.')), 10000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  const check = () => {
    if (current() !== identity) throw new Error('PLUR1BUS profile changed');
  };
  return async (path, options = {}) => {
    check();
    if (typeof api !== 'function' || typeof routes !== 'function') throw new Error('Profile-aware Hermes bridge required');
    const inventory = await bounded(routes());
    check();
    const matches = inventory.filter(route => route.profile === owner.profile
      && (!owner.connection || route.connectionId === owner.connection));
    if (matches.length !== 1 || !matches[0].connectionId || !matches[0].targetProfile) {
      throw unavailable('Für dieses Profil ist keine eindeutige Hermes-Verbindung verfügbar.');
    }
    const route = matches[0];
    const send = async (suffix, opts = {}, assertProfile = true) => {
      check();
      if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('#')
          || suffix.split('?')[0].split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) {
        throw new Error('Invalid PLUR1BUS API path');
      }
      const url = new URL(`/api/plugins/plur1bus${suffix}`, 'http://plur1bus.invalid');
      if (assertProfile) url.searchParams.set('expectedProfile', route.targetProfile);
      let result;
      try {
        result = await bounded(api({ path: url.pathname + url.search, connectionId: route.connectionId,
          profile: route.profile, method: opts.method, body: opts.body, timeoutMs: 10000 }));
      } catch (error) {
        // Never surface raw host errors (they can contain URLs or credentials).
        const message = String(error?.message || '');
        if (/404|not found|not enabled|disabled/i.test(message)) {
          throw Object.assign(unavailable('PLUR1BUS ist in diesem Profil nicht aktiviert oder sein Dashboard-Backend fehlt. Keine fremde Partition wird geladen.'), { plur1busDisabled: true });
        }
        if (/409|profile mismatch/i.test(message)) {
          throw unavailable('Hermes hat die Anfrage einem anderen Profil zugeordnet. Der Zugriff wurde sicher gesperrt.');
        }
        throw unavailable('Die profilgebundene Backend-Anfrage ist fehlgeschlagen. Bitte Verbindung und Backend prüfen.');
      }
      check();
      return result;
    };
    // Repeat the read-only handshake per operation. Old backends ignore query
    // guards; they must never receive memory reads or writes from this client.
    const capabilities = await send('/desktop/capabilities', {}, false);
    if (capabilities?.profileBinding !== 1 || capabilities.profile !== route.targetProfile) {
      const actual = /^[a-zA-Z0-9_-]{1,64}$/.test(capabilities?.profile || '') ? capabilities.profile : 'nicht bestätigt';
      throw unavailable(`Das Backend bestätigt dieses Profil nicht (Backend: ${actual}). Bitte PLUR1BUS im Zielprofil aktualisieren und dessen Desktop-Backend neu starten.`);
    }
    return path === '/desktop/capabilities' ? capabilities : send(path, options);
  };
}
const field = (label, value) => h('div', { key: label }, h('dt', null, label),
  h('dd', null, value == null || value === '' ? 'Nicht verfügbar' : String(value)));

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
    if (result.error) setError('Memory-Browser nicht erreichbar. Backend aktualisieren oder erneut versuchen.');
    else setPage({ ...result.value, query, status });
  }
  return h('section', null, h('h2', null, 'Memory-Browser'),
    h('p', null, 'Liest nur die ausgewählte Partition. Wörtliche Textsuche, keine semantische Recall-Abfrage und keine Änderungen an Erinnerungen.'),
    h('form', { className: 'pb-actions', onSubmit: event => { event.preventDefault(); void load(); } },
      h('label', null, 'Text suchen', h('input', { value: query, maxLength: 200, disabled: busy,
        onChange: event => setQuery(event.target.value), placeholder: 'Leer lassen für alle Erinnerungen' })),
      h('label', null, 'Status', h('select', { value: status, disabled: busy, onChange: event => setStatus(event.target.value) },
        ['active', 'archived', 'superseded', 'deleted'].map(value => h('option', { key: value, value }, value)))),
      h('button', { disabled: busy, type: 'submit' }, busy ? 'Wird gelesen…' : 'Erinnerungen laden')),
    error ? h('p', { role: 'alert' }, error) : null,
    page ? h(React.Fragment, null,
      h('p', { role: 'status' }, `${page.items?.length || 0} Ergebnisse · ab ${page.offset + 1} · ${page.status}`),
      h('ul', null, (page.items || []).map((item, index) => h('li', { key: `${item.id}-${index}` },
        h('details', null, h('summary', null, String(item.content || '(ohne Text)').slice(0, 140)),
          h('pre', null, String(item.content || '')),
          item.contentTruncated ? h('p', null, 'Vorschau auf 32.768 Zeichen gekürzt; gespeicherter Text unverändert.') : null,
          h('dl', { className: 'pb-grid' },
            ...['id', 'type', 'status', 'epistemicStatus', 'sourceRole', 'importance', 'createdAt', 'validFrom', 'validUntil', 'expiresAt']
              .filter(key => item[key] != null).map(key => field(key, item[key]))))))),
      h('div', { className: 'pb-actions' },
        h('button', { disabled: busy || !page.offset || query !== page.query || status !== page.status,
          onClick: () => { void load(Math.max(0, page.offset - 20)); } }, 'Zurück'),
        h('button', { disabled: busy || !page.hasMore || page.offset >= 100000 || query !== page.query || status !== page.status,
          onClick: () => { void load(page.offset + 20); } }, 'Weiter'))) : null);
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
    if (result.error) setNotice('Vorschlag nicht mehr verfügbar oder Revision geändert. Bitte Liste aktualisieren.');
    else setReview({ verb, proposal: verb ? result.value.review : result.value, nonce: result.value.nonce,
      warning: result.value.warning, expiresAt: Date.now() + (result.value.expiresInSeconds || 0) * 1000 });
  }
  async function confirm() {
    if (!review?.verb || busy || !capable) return;
    if (Date.now() >= review.expiresAt) { setReview(null); setNotice('Bestätigung abgelaufen. Bitte erneut prüfen.'); return; }
    setBusy(true); setNotice('');
    const result = await request.current?.run(`/desktop/workshop/${review.verb}`, { method: 'POST', body: {
      proposal_id: review.proposal.id, revision: review.proposal.revision, confirmation: review.verb, nonce: review.nonce,
    } });
    if (!result || result.stale) return;
    setBusy(false); setReview(null);
    setNotice(result.error ? 'Aktion nicht bestätigt. Nicht automatisch wiederholt; Zustand aktualisieren und erneut prüfen.' : 'Workshop-Aktion erfolgreich.');
    refresh();
  }
  return h('section', null, h('h2', null, 'Skill Workshop'),
    h('p', null, capable ? 'Vorschläge prüfen und anschließend ausdrücklich freigeben oder als Hermes-Skill veröffentlichen.'
      : 'Lesende Ansicht. Für Aktionen wird der aktualisierte Backendteil und die native Hermes-Authentifizierung benötigt.'),
    error ? h('p', { role: 'alert' }, error) : null,
    notice ? h('p', { role: 'status' }, notice) : null,
    !loading && !error && !proposals.length ? h('p', null, 'Keine Vorschläge im aktiven Scope.') : null,
    h('ul', null, proposals.map((p, index) => h('li', { key: `${p.id}-${index}` },
      h('strong', null, String(p.title || p.skillName || 'Unbenannter Vorschlag')),
      h('small', null, `Status: ${p.status || 'unbekannt'} · Revision: ${String(p.revision || '').slice(0, 12)}`),
      h('div', { className: 'pb-actions' },
        h('button', { disabled: busy, onClick: () => { void inspect(p, null); } }, 'Ansehen'),
        h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'approve'); } }, 'Freigabe prüfen'),
        h('button', { disabled: busy || !capable, onClick: () => { void inspect(p, 'publish'); } }, 'Veröffentlichung prüfen'))))),
    review ? h('div', { className: 'pb-review' }, h('h3', null, review.proposal.title),
      review.verb === 'publish' ? h('p', { role: 'alert' }, 'Achtung: Dieser Skill wird profilweit sichtbar, auch für andere Agenten dieses Hermes-Profils. PLUR1BUS-ACLs schützen den veröffentlichten Skill nicht.') : null,
      h('p', null, review.proposal.description), h('pre', null, review.proposal.instructions),
      h('p', null, `Evidenz: ${review.proposal.evidence?.length || 0} Datensätze · Revision: ${review.proposal.revision}`),
      h('div', { className: 'pb-actions' }, h('button', { disabled: busy, onClick: () => setReview(null) }, 'Schließen'),
        review.verb ? h('button', { disabled: busy, onClick: () => { void confirm(); } }, busy ? 'Wird übermittelt…'
          : review.verb === 'publish' ? 'Profilweite Veröffentlichung bestätigen' : 'Freigabe bestätigen') : null)) : null);
}
const css = `
.plur1bus-desktop{padding:24px;max-width:1200px;width:100%;height:100%;overflow:auto;margin:0 auto;color:var(--foreground);font:inherit}
.plur1bus-desktop header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.plur1bus-desktop h1{font-size:24px;font-weight:650}.plur1bus-desktop h2{font-size:16px;font-weight:600;margin-bottom:12px}
.plur1bus-desktop p{margin:8px 0;line-height:1.5}.plur1bus-desktop .pb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.plur1bus-desktop section{border:1px solid var(--border,#555);border-radius:10px;padding:18px;margin-bottom:16px}
.plur1bus-desktop dt{font-size:12px;opacity:.65;margin-top:12px}.plur1bus-desktop dd{overflow-wrap:anywhere;margin:3px 0 0}
.plur1bus-desktop button{border:1px solid var(--border,#777);border-radius:6px;padding:7px 12px;background:var(--muted,transparent);cursor:pointer}
.plur1bus-desktop button:disabled{opacity:.5;cursor:wait}.plur1bus-desktop li{padding:10px 0;border-top:1px solid var(--border,#555)}
.plur1bus-desktop small{display:block;opacity:.7}.plur1bus-desktop .pb-error{color:var(--destructive,#f88)}
.plur1bus-desktop .pb-actions{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:12px 0}
.plur1bus-desktop input,.plur1bus-desktop select{display:block;border:1px solid var(--border,#555);padding:8px;background:var(--background,#222);color:inherit;border-radius:6px}
.plur1bus-desktop pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:12px;background:var(--muted,#222)}
.plur1bus-desktop summary{cursor:pointer;padding:8px 0}.plur1bus-desktop .pb-review{padding:18px;border:1px solid var(--border,#555)}
.plur1bus-desktop .pb-check{display:flex;gap:10px;align-items:center;margin:12px 0}.plur1bus-desktop .pb-check input{display:inline-block}
`;

/** Build a provider form target without carrying stale credentials/model options across providers.
 * @param {string} provider Selected supported backend.
 * @param {string} kind Embedding or reranker.
 * @returns {object} Explicit editable defaults, never an automatic model download.
 */
export function retrievalDefaults(provider, kind) {
  if (provider === 'disabled') return { provider };
  if (provider === 'local-onnx') return { provider, model: 'jinaai/jina-embeddings-v5-text-nano-retrieval',
    revision: 'ac5d898c8d382b17167c33e5c8af644a3519b47d', dimensions: 768, modelDir: '',
    license: 'CC-BY-NC-4.0', licenseAccepted: false, queryPrefix: 'Query: ', passagePrefix: 'Document: ' };
  return { provider, model: '', ...(kind === 'embedding' ? { dimensions: 768 } : {}),
    ...(provider === 'local-transformers' ? { localFilesOnly: true } : { baseUrl: '', apiKeyEnv: '' }) };
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
      if (result.error) { setError('Auftragsstatus nicht erreichbar. Nicht erneut starten; Status erneut abfragen.'); return; }
      setJob({ id, ...result.value });
      if (['done', 'failed'].includes(result.value.status)) { jobRef.current = null; setBusy(false); }
    }
    const timer = setInterval(() => { void poll(); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [rest]);
  function edit(next) { sequence.current++; setTarget(next); setReview(null); setApproved(false); setError(''); }
  async function load() {
    setBusy(true); setError('');
    const result = await request.current?.run('/desktop/retrieval');
    if (!result || result.stale) return;
    setBusy(false);
    if (result.error) setError('Provider-Einstellungen nicht erreichbar. Backend aktualisieren oder Verbindung prüfen.');
    else {
      setSettings(result.value); setKind('embedding'); edit(result.value.embedding);
      const recent = await request.current?.run('/desktop/retrieval/jobs');
      if (!recent || recent.stale) return;
      if (recent.error) { setError('Auftragsstatus nicht erreichbar. Vor neuen Änderungen erneut laden.'); setSettings(null); return; }
      const latest = recent.value.jobs?.[0];
      if (latest) {
        setJob(latest);
        if (['queued', 'running'].includes(latest.status)) { jobRef.current = latest.id; setBusy(true); }
      }
    }
  }
  async function preview(action = kind) {
    const current = ++sequence.current;
    setBusy(true); setError(''); setReview(null); setApproved(false);
    const result = await request.current?.run('/desktop/retrieval/preview', { method: 'POST',
      body: { kind: action, ...(action === 'activate' ? { job: job.id } : { target }) } });
    if (!result || result.stale || current !== sequence.current) return;
    setBusy(false);
    if (result.error) setError('Vorschau nicht möglich. Modell, Dimensionen, Lizenz und vorhandene Quellpartition prüfen. Es wurde nichts umgestellt.');
    else setReview(result.value);
  }
  async function commit() {
    if (!review || !approved || busy) return;
    setBusy(true); setError('');
    const result = await request.current?.run('/desktop/retrieval/commit', { method: 'POST',
      body: { nonce: review.nonce, confirmation: review.kind } });
    if (!result || result.stale) return;
    setReview(null); setApproved(false);
    if (result.error) { setBusy(false); setError('Bestätigung nicht übernommen oder Antwort verloren. Keine automatische Wiederholung. Vor neuem Versuch den Auftragsstatus prüfen.'); }
    else { jobRef.current = result.value.job; setJob({ id: result.value.job, status: 'queued' }); }
  }
  const textField = (key, label, required = false) => h('label', { key }, label,
    h('input', { value: target[key] || '', maxLength: 2048, required, disabled: busy,
      onChange: event => { const next = { ...target }; if (event.target.value) next[key] = event.target.value; else delete next[key]; edit(next); } }));
  const providers = settings?.[kind === 'embedding' ? 'embeddingProviders' : 'rerankerProviders'] || [];
  return h('section', null, h('h2', null, 'Provider & Dimensionen'),
    h('p', null, 'Embedding-Provider wechseln, Reranking konfigurieren oder Erinnerungen in neue Dimensionen umbetten. Gilt ausschließlich für dieses Profil.'),
    h('button', { disabled: busy, onClick: () => { void load(); } }, settings ? 'Einstellungen neu laden' : 'Provider-Einstellungen öffnen'),
    settings ? h('form', { onSubmit: event => { event.preventDefault(); void preview(); } },
      h('div', { className: 'pb-actions' },
        h('label', null, 'Bereich', h('select', { value: kind, disabled: busy, onChange: event => {
          setKind(event.target.value); edit(settings[event.target.value]);
        } }, h('option', { value: 'embedding' }, 'Embeddings / Dimensionen'), h('option', { value: 'reranker' }, 'Reranking'))),
        h('label', null, 'Ziel-Provider', h('select', { value: target.provider || '', disabled: busy,
          onChange: event => edit(event.target.value === settings[kind].provider ? { ...settings[kind] }
            : retrievalDefaults(event.target.value, kind)) }, providers.map(value => h('option', { key: value, value }, value)))),
        target.provider !== 'disabled' ? textField('model', 'Ziel-Modell', true) : null,
        kind === 'embedding' ? h('label', null, 'Ziel-Dimensionen', h('input', { type: 'number', min: 1, max: 8192,
          required: true, value: target.dimensions || '', disabled: busy,
          onChange: event => edit({ ...target, dimensions: Number(event.target.value) }) })) : null),
      target.provider === 'local-onnx' ? h(React.Fragment, null,
        h('div', { className: 'pb-actions' }, textField('modelDir', 'Vorhandener Modellordner', true)),
        h('p', null, 'Jina v5 Nano unterstützt 32, 64, 128, 256, 512 und 768 Dimensionen. Vektoren werden aus den Originaltexten neu berechnet. Kein automatischer Modelldownload.'),
        h('label', { className: 'pb-check' }, h('input', { type: 'checkbox', checked: target.licenseAccepted === true, disabled: busy,
          onChange: event => edit({ ...target, licenseAccepted: event.target.checked }) }), 'CC-BY-NC-4.0 für dieses Modell akzeptieren (keine kommerzielle Nutzung).')) : null,
      ['openai-compatible', 'omlx', 'cohere'].includes(target.provider) ? h('div', { className: 'pb-actions' },
        target.provider !== 'cohere' ? textField('baseUrl', 'API-Basis-URL', target.provider === 'openai-compatible') : null,
        textField('apiKeyEnv', 'API-Key: Name der Umgebungsvariable')) : null,
      target.provider === 'local-transformers' ? h('div', { className: 'pb-actions' }, textField('revision', 'Modell-Revision (optional)'),
        textField('cacheDir', 'Modell-Cache (optional)')) : null,
      h('p', null, 'Vor Ausführung müssen Gateway und andere Memory-Laufzeiten dieses Speichers gestoppt sein. Hermes Desktop kann offen bleiben. Es werden keine Prozesse automatisch beendet.'),
      h('p', null, kind === 'embedding' ? 'Der bestehende Speicher bleibt erhalten. Ablauf: Vorschau, Backup & Umrechnung, Prüfung, separate Aktivierung.'
        : 'Reranking benötigt keine Vektormigration. Die Profilkonfiguration wird gesichert; die Änderung gilt nach Neustart der Memory-Laufzeit.'),
      h('button', { type: 'submit', disabled: busy }, 'Änderung prüfen')) : null,
    error ? h('p', { role: 'alert' }, error) : null,
    review ? h('div', { className: 'pb-review' }, h('h3', null, 'Änderung bestätigen'),
      h('p', null, `Profil ${review.profile} · Agent ${review.agentId} · ${review.target.provider} · ${review.target.model || 'deaktiviert'}`),
      review.cards != null ? h('p', null, `${review.cards} Erinnerungen → ${review.target.dimensions} Dimensionen`) : null,
      review.externalData ? h('p', { role: 'alert' }, 'Achtung: Dieser Provider erhält Erinnerungstexte über seine API. Prüfe den Endpoint und mögliche Kosten vor der Bestätigung.') : null,
      h('label', { className: 'pb-check' }, h('input', { type: 'checkbox', checked: approved, disabled: busy,
        onChange: event => setApproved(event.target.checked) }), 'Ich habe Ziel und Profil geprüft und bestätige diese Änderung.'),
      h('button', { disabled: busy || !approved, onClick: () => { void commit(); } },
        review.kind === 'activate' ? 'Geprüften Speicher aktivieren' : review.kind === 'embedding' ? 'Backup & Umrechnung starten' : 'Reranking speichern')) : null,
    job ? h('div', { role: 'status' },
      h('p', null, `Auftrag: ${job.status}${job.progress ? ` · ${job.progress.cursor}/${job.progress.cards}` : ''}`),
      job.status === 'failed' ? h('p', { role: 'alert' }, job.error === 'runtime_active'
        ? 'Eine Memory-Laufzeit ist noch aktiv. Gateway beenden, anschließend neu prüfen und bestätigen.'
        : 'Auftrag fehlgeschlagen. Quelle bleibt erhalten; Modellverfügbarkeit und Quelländerungen prüfen. Keine automatische Wiederholung.') : null,
      job.result?.validated ? h(React.Fragment, null, h('p', null, 'Backup vorhanden. Neue Vektoren und unveränderte Metadaten geprüft; noch nicht aktiv.'),
        h('button', { disabled: busy, onClick: () => { void preview('activate'); } }, 'Aktivierung prüfen')) : null,
      job.result?.restartRequired ? h('p', null, 'Gespeichert. Memory-Laufzeit jetzt neu starten und anschließend den Status aktualisieren.') : null) : null);
}

function Partition({ rest, profile }) {
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
      h('p', null, `Aktives Hermes-Profil: ${profile || 'default'}`)),
    h('button', { type: 'button', disabled: view.loading, onClick: () => { void reader.current?.load(); } },
      view.loading ? 'Wird geladen…' : 'Aktualisieren')),
    view.error ? h('p', { role: 'alert', className: 'pb-error' }, view.error) : null,
    h(HostCompatibility, { key: scopeKey() }),
    view.loading ? h('p', { role: 'status' }, 'Aktive Memory-Partition wird gelesen…') : null,
    s ? h(React.Fragment, null,
      h('p', { role: 'status' }, s.configured && s.storage?.status === 'ready'
        ? 'Memory-Partition konfiguriert und erreichbar.' : 'Memory-Partition benötigt Aufmerksamkeit.'),
      h('div', { className: 'pb-grid' },
        h('section', null, h('h2', null, 'Memory-Partition'), h('dl', null,
          field('Agent', s.agentId), field('Scope', s.scopeType), field('Datensätze', s.storage?.cards))),
        h('section', null, h('h2', null, 'Embeddings'), h('dl', null,
          field('Provider', embedding.provider), field('Modell', embedding.model), field('Dimensionen', embedding.dimensions))),
        h('section', null, h('h2', null, 'Reranking'), h('dl', null,
          field('Provider', reranker.provider), field('Modell', reranker.model))))) : null,
    s ? h(RetrievalSettings, { rest }) : null,
    s ? h(MemoryBrowser, { rest }) : null,
    s ? h(Workshop, { rest, proposals: view.proposals, error: view.workshopError, loading: view.loading,
      refresh: () => { void reader.current?.load(); } }) : null,
    h('p', null, 'Verwendet den bestehenden Hermes-Backendprozess. Kein separater Webserver erforderlich.'));
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
  description: 'Memory-Browser, Embedding-/Reranker-Status und geprüfte Skill-Workshop-Aktionen im aktiven Hermes-Profil.',
  defaultEnabled: true,
  register(ctx) {
    function Page() {
      const profile = useValue(host.state.profile);
      const connection = useValue(host.state.connectionId);
      const identity = JSON.stringify([connection, profile]);
      const rest = React.useMemo(() => createProfileTransport(
        typeof window !== 'undefined' && window.hermesDesktop?.api,
        host.profileRoutes, { connection, profile }, scopeKey, identity), [connection, profile]);
      return h(Partition, { key: identity, rest, profile });
    }
    let closeWorkspace = null;
    const supported = typeof host.openWorkspace === 'function';
    const open = () => {
      if (!supported) return;
      closeWorkspace = host.openWorkspace('plur1bus', { title: 'PLUR1BUS', render: () => h(Page),
        onClose: () => { closeWorkspace = null; } });
    };
    ctx.onDispose(() => { closeWorkspace?.(); closeWorkspace = null; });
    // Always discoverable even when a broken bridge prevents activation probes.
    // This is a diagnostic command, not an enabled-profile memory entry.
    let closeHelp = null;
    const removeHelp = ctx.registerMany([{ id: 'host-check', area: PALETTE_AREA,
      data: { id: 'plur1bus.host-check', label: 'PLUR1BUS: Desktop-Kompatibilität prüfen', run: () => {
        if (supported) closeHelp = host.openWorkspace('plur1bus-host-check', {
          title: 'PLUR1BUS-Kompatibilität', render: () => h(HostCompatibility, { key: scopeKey() }) });
        else host.notify?.({ kind: 'error', message: 'Hermes Workspace-API fehlt. Hermes aktualisieren oder scripts/hermes-desktop-host.py aus dem PLUR1BUS-Paket verwenden.' });
      } } }]);
    ctx.onDispose(() => { removeHelp(); closeHelp?.(); });
    // Retire our old experimental route, which Hermes can mistake for a chat.
    if (typeof window !== 'undefined' && window.location.hash === '#/plur1bus') host.navigate('/');
    let removeNavigation = null;
    const notified = new Set();
    const visibility = createNavigationVisibility(async () => {
      const report = await checkDesktopCompatibility(host, typeof window !== 'undefined' && window.hermesDesktop, scopeKey);
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
        data: { codicon: 'database', label: 'PLUR1BUS', onSelect: open } }] : []),
      { id: 'open-button', area: STATUSBAR_AREAS.left, order: 55,
        data: { id: 'plur1bus-open', variant: 'action', label: 'PLUR1BUS', disabled: !supported, onSelect: open,
          title: supported ? 'PLUR1BUS als Workspace öffnen' : 'Hermes Desktop mit openWorkspace-Unterstützung erforderlich' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'plur1bus.open', label: 'PLUR1BUS öffnen',
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
