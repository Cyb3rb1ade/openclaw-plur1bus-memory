export default async function memoryLancedbStockRuntime(api) {
  api?.logger?.warn?.(
    "memory-lancedb-stock is dependency-only in this local setup; use memory-lancedb-namespaced for runtime memory tools.",
  );
}
