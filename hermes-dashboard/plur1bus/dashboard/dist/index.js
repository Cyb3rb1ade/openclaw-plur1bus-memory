(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__, registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;
  const React = SDK.React, C = SDK.components || {}, base = "/api/plugins/plur1bus";
  const json = function (path, options) { return SDK.fetchJSON(base + path, options || {}); };
  const field = function (label, value) { return React.createElement("div", { className: "pb-field", key: label }, React.createElement("dt", null, label), React.createElement("dd", null, value == null || value === "" ? "Not available" : String(value))); };

  function StatusPage() {
    const d = React.useState(null), data = d[0], setData = d[1];
    const p = React.useState([]), proposals = p[0], setProposals = p[1];
    const r = React.useState(null), review = r[0], setReview = r[1];
    const l = React.useState(true), loading = l[0], setLoading = l[1];
    const n = React.useState(""), notice = n[0], setNotice = n[1];
    const b = React.useState(false), busy = b[0], setBusy = b[1];
    const Panel = C.Card || "section", Content = C.CardContent || "div", Button = C.Button || "button";
    const load = React.useCallback(function () {
      setLoading(true); setNotice("");
      Promise.all([json("/status"), json("/workshop/proposals")])
        .then(function (values) { setData(values[0]); setProposals(values[1].proposals || []); })
        .catch(function () { setData(null); setProposals([]); setNotice("Dashboard data is unavailable."); })
        .finally(function () { setLoading(false); });
    }, []);
    React.useEffect(function () { load(); }, [load]);
    const preview = React.useCallback(function (verb, proposal) {
      setBusy(true); setNotice("");
      json("/workshop/" + verb + "/preview/" + encodeURIComponent(proposal.id) + "?revision=" + encodeURIComponent(proposal.revision))
        .then(function (value) { setReview({ verb: verb, proposal: value.review, nonce: value.nonce, warning: value.warning || "" }); })
        .catch(function () { setNotice("That proposal can no longer be reviewed. Refresh the list."); setReview(null); })
        .finally(function () { setBusy(false); });
    }, []);
    const confirm = React.useCallback(function () {
      if (!review) return;
      setBusy(true); setNotice("");
      json("/workshop/" + review.verb, { method: "POST", headers: { "Content-Type": "application/json", "X-Plur1bus-Confirm": review.verb, "X-Plur1bus-Action-Nonce": review.nonce }, body: JSON.stringify({ proposal_id: review.proposal.id, revision: review.proposal.revision }) })
        .then(function () { setNotice("Workshop action completed."); setReview(null); load(); })
        .catch(function () { setNotice("Action was rejected. Review again before retrying."); setReview(null); })
        .finally(function () { setBusy(false); });
    }, [review, load]);
    const storage = data && data.storage ? data.storage : {}, embedding = data && data.embedding ? data.embedding : {}, configured = Boolean(data && data.configured), reviewed = review && review.proposal;
    return React.createElement("main", { className: "pb-page" },
      React.createElement("header", { className: "pb-header" }, React.createElement("div", null, React.createElement("h1", null, "Memory status"), React.createElement("p", null, "This view reports the memory partition selected by the dashboard server.")), React.createElement(Button, { onClick: load, disabled: loading || busy }, loading ? "Checking…" : "Refresh")),
      React.createElement("div", { className: "pb-signal " + (configured ? "is-ready" : "is-degraded") }, React.createElement("span", { "aria-hidden": "true" }), configured ? "Memory partition configured" : "Memory partition needs attention"),
      notice ? React.createElement(Panel, { className: "pb-error" }, React.createElement(Content, null, notice)) : null,
      !loading && data ? React.createElement("div", { className: "pb-grid" }, React.createElement(Panel, null, React.createElement(Content, null, React.createElement("h2", null, "Active partition"), React.createElement("dl", null, field("Agent", data.agentId), field("Scope", data.scopeType), field("Cards", storage.cards)))), React.createElement(Panel, null, React.createElement(Content, null, React.createElement("h2", null, "Retrieval"), React.createElement("dl", null, field("Embedding provider", embedding.provider), field("Model", embedding.model), field("Dimensions", embedding.dimensions), field("Credentials", embedding.credentials))))) : null,
      React.createElement(Panel, { className: "pb-workshop" }, React.createElement(Content, null, React.createElement("h2", null, "Skill Workshop"), React.createElement("p", null, "Only existing scoped proposals are shown. Mining and activation are not available here."), proposals.length ? React.createElement("ul", { className: "pb-proposals" }, proposals.map(function (proposal) { return React.createElement("li", { key: proposal.id }, React.createElement("div", null, React.createElement("strong", null, proposal.title || proposal.skillName || "Untitled proposal"), React.createElement("small", null, "Revision " + String(proposal.revision || "").slice(0, 12))), React.createElement(Button, { onClick: function () { preview("approve", proposal); }, disabled: busy }, "Review approval"), React.createElement(Button, { onClick: function () { preview("publish", proposal); }, disabled: busy }, "Review publish")); })) : React.createElement("p", { className: "pb-empty" }, "No proposals in this active scope."))),
      reviewed ? React.createElement(Panel, { className: "pb-review" }, React.createElement(Content, null, React.createElement("h2", null, review.verb === "publish" ? "Review profile-wide publication" : "Review approval"), review.warning ? React.createElement("p", { className: "pb-warning" }, review.warning) : null, React.createElement("dl", null, field("Skill", reviewed.skillName), field("Status", reviewed.status), field("Evidence records", Array.isArray(reviewed.evidence) ? reviewed.evidence.length : 0)), React.createElement("h3", null, reviewed.title || "Untitled proposal"), React.createElement("p", null, reviewed.description || "No description"), React.createElement("pre", { className: "pb-instructions" }, reviewed.instructions || "No instructions"), React.createElement("div", { className: "pb-actions" }, React.createElement(Button, { onClick: function () { setReview(null); }, disabled: busy }, "Cancel"), React.createElement(Button, { onClick: confirm, disabled: busy }, busy ? "Submitting…" : (review.verb === "publish" ? "Confirm publish" : "Confirm approval"))))) : null,
      loading ? React.createElement("p", { className: "pb-loading" }, "Reading active memory status…") : null);
  }
  registry.register("plur1bus", StatusPage);
})();
