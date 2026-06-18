export const DEFAULT_NAMESPACE = "lancedb-namespaced";

export function resolveWriteNamespace(nsCfg = {}) {
  return nsCfg.activeWriteNamespace || DEFAULT_NAMESPACE;
}

export function resolveRecallReadNamespaces(nsCfg = {}) {
  if (!nsCfg.activeRecallNamespaces && !nsCfg.legacyReadOnlyNamespaces) {
    return [DEFAULT_NAMESPACE];
  }
  const active = Array.isArray(nsCfg.activeRecallNamespaces)
    ? nsCfg.activeRecallNamespaces
    : [DEFAULT_NAMESPACE];
  if (!nsCfg.crossNamespaceRecall) return [...new Set(active)];
  const legacy = Array.isArray(nsCfg.legacyReadOnlyNamespaces)
    ? nsCfg.legacyReadOnlyNamespaces
    : [];
  return [...new Set([...active, ...legacy])];
}

export function isLegacyReadOnly(namespaceName, nsCfg = {}) {
  const legacy = Array.isArray(nsCfg.legacyReadOnlyNamespaces)
    ? nsCfg.legacyReadOnlyNamespaces
    : [];
  return legacy.includes(namespaceName);
}
