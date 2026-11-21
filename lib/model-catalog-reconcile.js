const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function strings(value, output) {
  if (typeof value === "string") output.add(value);
  else if (Array.isArray(value)) for (const child of value) strings(child, output);
  else for (const child of Object.values(record(value))) strings(child, output);
}

/**
 * Reconcile complete, authenticated inventories without changing routing or grants.
 * Empty/partial/error inventories are inconclusive, and never remove models.
 * @param {object} hostConfig Current configuration, not mutated.
 * @param {object} inventories Provider-keyed verified inventories.
 * @param {{referencedModels?: string[]}} options Additional session/cron pins.
 * @returns {object} Updated config and credential-free change report.
 */
export function reconcileModelCatalog(hostConfig, inventories, { referencedModels = [] } = {}) {
  const config = structuredClone(hostConfig);
  const refs = new Set(referencedModels);
  const referenceConfig = structuredClone(hostConfig);
  delete referenceConfig.models;
  for (const plugin of Object.values(record(referenceConfig.plugins?.entries))) delete record(plugin).llm;
  const agents = record(referenceConfig.agents);
  delete record(agents.defaults).models;
  const listed = agents.entries ?? agents.list ?? [];
  for (const agent of Array.isArray(listed) ? listed : Object.values(record(listed))) delete record(agent).models;
  strings(referenceConfig, refs);
  // A configured alias may be the persisted primary/fallback/cron choice.
  const definitions = [hostConfig.agents?.defaults?.models];
  const known = hostConfig.agents?.entries ?? hostConfig.agents?.list ?? [];
  for (const agent of Array.isArray(known) ? known : Object.values(record(known))) definitions.push(agent?.models);
  const normalizedRefs = new Set([...refs].map((ref) => typeof ref === "string" ? ref.trim().toLowerCase() : ref));
  for (const models of definitions) for (const [id, metadata] of Object.entries(record(models))) {
    if (typeof metadata?.alias === "string" && normalizedRefs.has(metadata.alias.trim().toLowerCase())) refs.add(id);
  }
  const removed = [], renamed = [], retainedAbsent = [], unverifiable = [];
  for (const [provider, definition] of Object.entries(record(config.models?.providers))) {
    const inventory = inventories?.[provider];
    if (inventory?.status !== "verified" || inventory.complete !== true || !Array.isArray(inventory.models) || !inventory.models.length) {
      unverifiable.push(provider);
      continue;
    }
    const available = new Map(inventory.models.filter((m) => typeof m?.id === "string" && m.id.length <= 256).map((m) => [m.id, m]));
    if (!available.size) { unverifiable.push(provider); continue; }
    definition.models = (definition.models ?? []).filter((model) => {
      const id = `${provider}/${model.id}`;
      const current = available.get(model.id);
      if (current) {
        const reportedName = typeof current.name === "string" ? current.name.trim() : "";
        // An ID-only response must not replace an existing human-readable name.
        const name = reportedName && reportedName !== model.id ? reportedName.slice(0, 160) : model.name || model.id;
        if (model.name !== name) { model.name = name; renamed.push(id); }
        return true;
      }
      if (refs.has(id)) {
        retainedAbsent.push(id);
        model.name = `${String(model.name || model.id).replace(/ \(not listed by provider\)$/, "").slice(0, 130)} (not listed by provider)`;
        return true;
      }
      removed.push(id); return false;
    });
    // Allowlists may contain models absent from provider.models as well.
    const allDefinitions = [config.agents?.defaults?.models];
    const entries = config.agents?.entries ?? config.agents?.list ?? [];
    for (const agent of Array.isArray(entries) ? entries : Object.values(record(entries))) allDefinitions.push(agent?.models);
    for (const models of allDefinitions) for (const id of Object.keys(record(models))) {
      if (!id.startsWith(`${provider}/`) || available.has(id.slice(provider.length + 1)) || refs.has(id)) continue;
      delete models[id];
      if (!removed.includes(id)) removed.push(id);
    }
  }
  return { config, removed, renamed, retainedAbsent, unverifiable };
}
