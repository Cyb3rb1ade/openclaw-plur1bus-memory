(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__, registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;
  const React = SDK.React, C = SDK.components || {}, base = "/api/plugins/plur1bus";
  const json = function (path, options) { return SDK.fetchJSON(base + path, options || {}); };
  const field = function (label, value) { return React.createElement("div", { className: "pb-field", key: label }, React.createElement("dt", null, label), React.createElement("dd", null, value == null || value === "" ? "Not available" : String(value))); };

  function ObsidianPanel() {
    const r = React.useState(null), review = r[0], setReview = r[1];
    const b = React.useState(false), busy = b[0], setBusy = b[1];
    const n = React.useState(""), notice = n[0], setNotice = n[1];
    async function preview() {
      setBusy(true); setReview(null); setNotice("");
      try { setReview(await json("/obsidian/preview")); }
      catch (_error) { setNotice("Workspace cannot be reviewed. Check source size and backend version."); }
      finally { setBusy(false); }
    }
    async function confirm() {
      if (!review || busy) return;
      setBusy(true);
      try {
        const result = await json("/obsidian/sync", { method: "POST", headers: { "Content-Type": "application/json", "X-Plur1bus-Confirm": "obsidian-sync" },
          body: JSON.stringify({ revision: review.revision, nonce: review.nonce, confirmation: "obsidian-sync" }) });
        setNotice(result.files + " notes imported. Original files unchanged.");
      } catch (_error) { setNotice("Import not fully confirmed. Review again; stored chunks are not duplicated."); }
      finally { setBusy(false); setReview(null); }
    }
    return React.createElement("section", { className: "pb-workshop" }, React.createElement("h2", null, "Obsidian & Workspace"),
      React.createElement("p", null, "Review changed Markdown in this agent's configured workspace. Import appends observations; it never overwrites source files or existing memories."),
      React.createElement("button", { disabled: busy, onClick: preview }, "Review changed notes"),
      notice ? React.createElement("p", { role: "status" }, notice) : null,
      review ? React.createElement("div", { className: "pb-review" }, React.createElement("p", null, "Agent: " + review.agentId),
        React.createElement("ul", null, review.files.map(file => React.createElement("li", { key: file.path }, file.path + " · " + file.sha256.slice(0, 12)))),
        React.createElement("p", null, "Read the listed source notes before confirming. Changed revisions require a new review."),
        React.createElement("button", { disabled: busy, onClick: () => setReview(null) }, "Cancel"),
        React.createElement("button", { disabled: busy || !review.files.length, onClick: confirm }, "Import reviewed notes")) : null);
  }

  function SettingsPanel() {
    const [data, setData] = React.useState(null), [review, setReview] = React.useState(null);
    const [notice, setNotice] = React.useState(""), [busy, setBusy] = React.useState(false);
    async function load() {
      try { setData(await json("/settings")); }
      catch (_error) { setNotice("Settings unavailable for this authenticated profile."); }
    }
    React.useEffect(function () { load(); }, []);
    async function preview(identifier, value) {
      if (!data || busy) return;
      setBusy(true); setReview(null); setNotice("");
      try {
        setReview(await json("/settings/preview", { method: "POST",
          headers: { "Content-Type": "application/json", "X-Plur1bus-Confirm": "settings-preview" },
          body: JSON.stringify({ identifier, value, revision: data.revision }) }));
      } catch (_error) { setNotice("Setting changed or unavailable. Refresh before reviewing again."); }
      finally { setBusy(false); }
    }
    async function save() {
      if (!review || busy) return;
      setBusy(true);
      try {
        await json("/settings", { method: "POST",
          headers: { "Content-Type": "application/json", "X-Plur1bus-Confirm": "settings" },
          body: JSON.stringify({ identifier: review.identifier, value: review.value,
            revision: review.revision, nonce: review.nonce }) });
        setNotice("Saved. Restart the Hermes gateway to activate; running state is not yet verified.");
        await load();
      } catch (_error) { setNotice("Save rejected. Review the setting again."); }
      finally { setReview(null); setBusy(false); }
    }
    return React.createElement("section", { className: "pb-workshop" },
      React.createElement("h2", null, "Features, storage mode & task models"),
      React.createElement("p", null, "Saved settings for the active profile — not a live gateway status. Empty model selection inherits the default."),
      notice ? React.createElement("p", { role: "status" }, notice) : null,
      data ? React.createElement("div", null, data.settings.map(setting => React.createElement("label", { key: setting.id },
        setting.id + " ", React.createElement("select", { disabled: busy, value: String(setting.choices.indexOf(setting.value)),
          onChange: event => preview(setting.id, setting.choices[Number(event.target.value)]) },
        setting.choices.map((value, index) => React.createElement("option", { key: index, value: String(index) },
          value === "" ? "Inherit default" : String(value))))))) : null,
      review ? React.createElement("div", { className: "pb-review" },
        React.createElement("p", null, "Agent " + review.agentId + ": " + review.identifier + " → " + String(review.value)),
        React.createElement("p", null, "Requires a gateway restart. No memory records will be migrated or deleted."),
        React.createElement("button", { disabled: busy, onClick: () => setReview(null) }, "Cancel"),
        React.createElement("button", { disabled: busy, onClick: save }, "Confirm save")) : null);
  }

  function StatusPage() {
    const d = React.useState(null), data = d[0], setData = d[1];
    const p = React.useState([]), proposals = p[0], setProposals = p[1];
    const r = React.useState(null), review = r[0], setReview = r[1];
    const l = React.useState(true), loading = l[0], setLoading = l[1];
    const n = React.useState(""), notice = n[0], setNotice = n[1];
    const b = React.useState(false), busy = b[0], setBusy = b[1];
    const Panel = C.Card || "section", Content = C.CardContent || "div", Button = C.Button || "button";
    const load = React.useCallback(function (completedNotice) {
      const message = typeof completedNotice === "string" ? completedNotice : "";
      setLoading(true); setNotice(message);
      return Promise.all([json("/status"), json("/workshop/proposals")])
        .then(function (values) { setData(values[0]); setProposals(values[1].proposals || []); })
        .catch(function () { setData(null); setProposals([]); setNotice((message ? message + " " : "") + "Dashboard data is unavailable."); })
        .finally(function () { setLoading(false); });
    }, []);
    React.useEffect(function () { load(); }, [load]);
    const preview = React.useCallback(function (verb, proposal) {
      setBusy(true); setNotice("");
      json(verb === "inspect" ? "/workshop/proposals/" + encodeURIComponent(proposal.id) : "/workshop/" + verb + "/preview/" + encodeURIComponent(proposal.id) + "?revision=" + encodeURIComponent(proposal.revision))
        .then(function (value) { setReview({ verb: verb, proposal: verb === "inspect" ? value : value.review, nonce: value.nonce, warning: value.warning || "" }); })
        .catch(function () { setNotice("That proposal can no longer be reviewed. Refresh the list."); setReview(null); })
        .finally(function () { setBusy(false); });
    }, []);
    const confirm = React.useCallback(function () {
      if (!review || review.verb === "inspect") return;
      setBusy(true); setNotice("");
      json("/workshop/" + review.verb, { method: "POST", headers: { "Content-Type": "application/json", "X-Plur1bus-Confirm": review.verb, "X-Plur1bus-Action-Nonce": review.nonce }, body: JSON.stringify({ proposal_id: review.proposal.id, revision: review.proposal.revision }) })
        .then(function (result) { setReview(null); return load(result && result.activationPartial ? "Skill published; evidence confirmation is still incomplete. Review Finish evidence confirmation to retry." : "Workshop action completed."); })
        .catch(function () { setNotice("Action was rejected. Review again before retrying."); setReview(null); })
        .finally(function () { setBusy(false); });
    }, [review, load]);
    const storage = data && data.storage ? data.storage : {}, embedding = data && data.embedding ? data.embedding : {}, configured = Boolean(data && data.configured), reviewed = review && review.proposal;
    const primaryRows = data && data.scopeType === "agent-private" && Array.isArray(data.cards?.byPrimaryAgent)
      ? data.cards.byPrimaryAgent.filter(row => row && row.id === data.agentId) : [];
    return React.createElement("main", { className: "pb-page" },
      React.createElement("header", { className: "pb-header" }, React.createElement("div", null, React.createElement("h1", null, "Memory status"), React.createElement("p", null, "This view reports the memory partition selected by the dashboard server.")), React.createElement(Button, { onClick: load, disabled: loading || busy }, loading ? "Checking…" : "Refresh")),
      React.createElement("div", { className: "pb-signal " + (configured ? "is-ready" : "is-degraded") }, React.createElement("span", { "aria-hidden": "true" }), configured ? "Memory partition configured" : "Memory partition needs attention"),
      notice ? React.createElement(Panel, { className: "pb-error" }, React.createElement(Content, null, notice)) : null,
      !loading && data ? React.createElement("div", { className: "pb-grid" }, React.createElement(Panel, null, React.createElement(Content, null, React.createElement("h2", null, "Active partition"), React.createElement("dl", null, field("Agent", data.agentId), field("Scope", data.scopeType), field("Cards", storage.cards)))), React.createElement(Panel, null, React.createElement(Content, null, React.createElement("h2", null, "Retrieval"), React.createElement("dl", null, field("Embedding provider", embedding.provider), field("Model", embedding.model), field("Dimensions", embedding.dimensions), field("Credentials", embedding.credentials))))) : null,
      data ? React.createElement(Panel, null, React.createElement(Content, null,
        React.createElement("h2", null, "Cards by primary agent · active profile"),
        React.createElement("p", null, "Private cards in this profile. Other profiles and subagents are not scanned."),
        ...primaryRows.map(row => React.createElement("dl", { key: row.id }, field("Profile", row.profile),
          field("Agent", row.id), field("Cards", Number.isSafeInteger(row.cards) && row.cards >= 0 ? row.cards : null))),
        !primaryRows.length ? React.createElement("p", null, "No private primary-agent count available.") : null)) : null,
      React.createElement(Panel, { className: "pb-workshop" }, React.createElement(Content, null,
        React.createElement("h2", null, "Skill Workshop · Mined Skills"),
        React.createElement("p", null, "Review scoped proposals and applied skills. Withdrawal archives unchanged generated content and preserves manual edits."),
        proposals.length ? React.createElement("ul", { className: "pb-proposals" }, proposals.map(function (proposal) {
          const actions = [["inspect", "View skill"]];
          if (proposal.status === "pending_review") actions.push(["approve", "Review approval"]);
          if (proposal.status === "approved" || proposal.activationPartial) actions.push(["publish", proposal.activationPartial ? "Finish evidence confirmation" : "Review publish"]);
          if (["pending_review", "approved"].includes(proposal.status)) actions.push(["reject", "Decline"]);
          if (proposal.status === "published") actions.push(["withdraw", "Withdraw"]);
          return React.createElement("li", { key: proposal.id },
            React.createElement("div", null, React.createElement("strong", null, proposal.title || proposal.skillName || "Untitled proposal"),
              React.createElement("small", null, String(proposal.status || "") + " · " + String(proposal.category || "workflow") + " · confidence " + String(proposal.confidence ?? "—") + " · evidence " + String(proposal.evidenceCount || 0)),
              React.createElement("small", null, String(proposal.createdAt || "").slice(0, 10)),
              React.createElement("p", null, String(proposal.benefit || "").slice(0, 500))),
            ...actions.map(function (action) { return React.createElement(Button, { key: action[0], onClick: function () { preview(action[0], proposal); }, disabled: busy }, action[1]); }));
        })) : React.createElement("p", { className: "pb-empty" }, "No proposals in this active scope."))),

      reviewed ? React.createElement(Panel, { className: "pb-review" }, React.createElement(Content, null, React.createElement("h2", null, ({ publish: "Review profile-wide publication", approve: "Review approval", reject: "Reject proposal", withdraw: "Withdraw generated skill", inspect: "Mined skill" })[review.verb]), review.warning ? React.createElement("p", { className: "pb-warning" }, review.warning) : null, React.createElement("dl", null, field("Skill", reviewed.skillName), field("Status", reviewed.status), field("Evidence records", Array.isArray(reviewed.evidence) ? reviewed.evidence.length : 0)), React.createElement("h3", null, reviewed.title || "Untitled proposal"), React.createElement("p", null, reviewed.description || "No description"), React.createElement("p", null, reviewed.benefit || ""), React.createElement("pre", { className: "pb-instructions" }, reviewed.instructions || "No instructions"), React.createElement("div", { className: "pb-actions" }, React.createElement(Button, { onClick: function () { setReview(null); }, disabled: busy }, "Cancel"), review.verb !== "inspect" ? React.createElement(Button, { onClick: confirm, disabled: busy }, busy ? "Submitting…" : ({ publish: "Confirm publish", approve: "Confirm approval", reject: "Confirm rejection", withdraw: "Confirm withdrawal" })[review.verb]) : null))) : null,
      data ? React.createElement(ObsidianPanel) : null,
      data ? React.createElement(SettingsPanel) : null,
      loading ? React.createElement("p", { className: "pb-loading" }, "Reading active memory status…") : null);
  }
  registry.register("plur1bus", StatusPage);
})();
