import React from 'react';
import { host, useValue, STATUSBAR_AREAS, PALETTE_AREA } from '@hermes/plugin-sdk';

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
          throw unavailable('PLUR1BUS ist in diesem Profil nicht aktiviert oder sein Dashboard-Backend fehlt. Keine fremde Partition wird geladen.');
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
`;

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
    s ? h(MemoryBrowser, { rest }) : null,
    s ? h(Workshop, { rest, proposals: view.proposals, error: view.workshopError, loading: view.loading,
      refresh: () => { void reader.current?.load(); } }) : null,
    h('p', null, 'Verwendet den bestehenden Hermes-Backendprozess. Kein separater Webserver erforderlich.'));
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
    // Retire our old experimental route, which Hermes can mistake for a chat.
    if (typeof window !== 'undefined' && window.location.hash === '#/plur1bus') host.navigate('/');
    ctx.registerMany([
      { id: 'open-button', area: STATUSBAR_AREAS.left, order: 55,
        data: { id: 'plur1bus-open', variant: 'action', label: 'PLUR1BUS', disabled: !supported, onSelect: open,
          title: supported ? 'PLUR1BUS als Workspace öffnen' : 'Hermes Desktop mit openWorkspace-Unterstützung erforderlich' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'plur1bus.open', label: 'PLUR1BUS öffnen',
        keywords: ['memory', 'embeddings', 'reranker', 'plur1bus'], run: open } },
    ]);
  },
};
