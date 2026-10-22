// Prebuilt, dependency-free browser entry. The host activates it for this
// plugin when Settings > Labs > Custom plugin UI is enabled.
const DASHBOARD_PATH = "/plugins/memory-lancedb-namespaced/control";
const REQUEST_TYPE = "plur1bus-jev-key-request";
const RESULT_TYPE = "plur1bus-jev-key-result";
const RESULT_CODES = new Set([
  "jev_key_saved", "jev_key_removed", "jev_key_unchanged",
  "denied_mode", "denied_token", "denied_action", "denied_value", "failed",
]);

function validRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.type !== REQUEST_TYPE || typeof data.requestId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(data.requestId)) return false;
  const keys = data.action === "probe" ? ["type", "requestId", "action"]
    : data.action === "save" ? ["type", "requestId", "action", "formToken", "apiKey"]
      : data.action === "remove" ? ["type", "requestId", "action", "formToken"] : null;
  if (!keys || Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key))) return false;
  if (data.action === "probe") return true;
  if (typeof data.formToken !== "string" || data.formToken.length < 16 || data.formToken.length > 256) return false;
  return data.action !== "save" || (typeof data.apiKey === "string" && data.apiKey.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(data.apiKey));
}

function dashboardFrame(event) {
  if (event.origin !== "null" || event.ports?.length) return null;
  for (const frame of document.querySelectorAll("iframe")) {
    if (!frame.isConnected || frame.contentWindow !== event.source) continue;
    try {
      const url = new URL(frame.src, window.location.href);
      if (url.origin === window.location.origin && url.pathname === DASHBOARD_PATH) return frame;
    } catch {
      return null;
    }
  }
  return null;
}

export default {
  id: "memory-lancedb-namespaced",
  /**
   * Relay only typed Jev key operations from this plugin's sandboxed dashboard.
   * @param {object} host Authenticated native Control UI host.
   * @returns {Function} Listener disposer for the activation lifetime.
   */
  activate(host) {
    let disposed = false;
    const listener = async (event) => {
      if (disposed || host.signal.aborted || !validRequest(event.data)) return;
      const frame = dashboardFrame(event);
      if (!frame) return;
      const data = event.data;
      const reply = (code) => {
        // Never reply to a detached/replaced frame or an ended activation.
        if (!disposed && !host.signal.aborted && dashboardFrame(event) === frame) {
          frame.contentWindow.postMessage({ type: RESULT_TYPE, requestId: data.requestId, code }, "*");
        }
      };
      if (!host.connection.connected || !host.connection.canWrite) {
        reply("unavailable");
        return;
      }
      if (data.action === "probe") {
        reply("ready");
        return;
      }
      try {
        const result = await host.request("plur1bus.control.jevKey", {
          action: data.action,
          formToken: data.formToken,
          ...(data.action === "save" ? { apiKey: data.apiKey } : {}),
        });
        reply(RESULT_CODES.has(result?.code) ? result.code : "failed");
      } catch {
        // RPC errors may contain submitted values. Return only a fixed code.
        reply("failed");
      }
    };
    window.addEventListener("message", listener);
    return () => {
      disposed = true;
      window.removeEventListener("message", listener);
    };
  },
};
