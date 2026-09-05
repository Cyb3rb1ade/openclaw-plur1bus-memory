(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;

  const React = SDK.React;
  const C = SDK.components || {};
  const endpoint = "/api/plugins/plur1bus/status";

  function field(label, value) {
    return React.createElement("div", { className: "pb-field", key: label },
      React.createElement("dt", null, label),
      React.createElement("dd", null, value == null || value === "" ? "Not available" : String(value)));
  }

  function StatusPage() {
    const state = React.useState(null);
    const data = state[0];
    const setData = state[1];
    const loadingState = React.useState(true);
    const loading = loadingState[0];
    const setLoading = loadingState[1];
    const errorState = React.useState(false);
    const failed = errorState[0];
    const setFailed = errorState[1];

    const load = React.useCallback(function () {
      setLoading(true);
      setFailed(false);
      fetch(endpoint, { credentials: "same-origin" })
        .then(function (response) { if (!response.ok) throw new Error("status unavailable"); return response.json(); })
        .then(setData)
        .catch(function () { setFailed(true); setData(null); })
        .finally(function () { setLoading(false); });
    }, []);

    React.useEffect(function () { load(); }, [load]);
    const storage = data && data.storage ? data.storage : {};
    const embedding = data && data.embedding ? data.embedding : {};
    const isConfigured = Boolean(data && data.configured);
    const Panel = C.Card || "section";
    const PanelContent = C.CardContent || "div";
    const Button = C.Button || "button";

    return React.createElement("main", { className: "pb-page" },
      React.createElement("header", { className: "pb-header" },
        React.createElement("div", null,
          React.createElement("h1", null, "Memory status"),
          React.createElement("p", null, "This view reports the memory partition selected by the dashboard server.")),
        React.createElement(Button, { onClick: load, disabled: loading }, loading ? "Checking…" : "Refresh")),
      React.createElement("div", { className: "pb-signal " + (isConfigured ? "is-ready" : "is-degraded") },
        React.createElement("span", { "aria-hidden": "true" }),
        isConfigured ? "Memory partition configured" : "Memory partition needs attention"),
      failed ? React.createElement(Panel, { className: "pb-error" }, React.createElement(PanelContent, null,
        "Status is unavailable. Check the active Hermes profile and PLUR1BUS installation.")) : null,
      !loading && data ? React.createElement("div", { className: "pb-grid" },
        React.createElement(Panel, null, React.createElement(PanelContent, null,
          React.createElement("h2", null, "Active partition"),
          React.createElement("dl", null, field("Agent", data.agentId), field("Scope", data.scopeType), field("Cards", storage.cards)))),
        React.createElement(Panel, null, React.createElement(PanelContent, null,
          React.createElement("h2", null, "Retrieval"),
          React.createElement("dl", null, field("Embedding provider", embedding.provider), field("Model", embedding.model), field("Dimensions", embedding.dimensions), field("Credentials", embedding.credentials))))) : null,
      loading ? React.createElement("p", { className: "pb-loading" }, "Reading active memory status…") : null);
  }

  registry.register("plur1bus", StatusPage);
})();
