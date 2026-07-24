# Attack-path analysis — Startup patch uploads native-memory queries and snippets despite a local or disabled reranker selection

Candidate: `cand-startup-cohere-reranker-config-bypass`

## Path

1. **Source / trust boundary:** OpenClaw native memory search produces a cleaned user query and merged result snippets that can contain private conversation and memory content.
2. **Nearest or broken control:** The installer always applies the patch, and the injected code treats presence of COHERE_API_KEY in the OpenClaw state .env as the sole enablement signal. It never checks the effective configured reranker provider/enabled state, including the installer's explicit local and disabled modes.
3. **Sink:** The patched manager POSTs query=cleaned and documents=merged snippets to the fixed https://api.cohere.com/v2/rerank endpoint with the discovered key.
4. **Security outcome if exploitable:** An operator who selected local or disabled reranking, or retained a Cohere key for another component, can unknowingly disclose memory queries and retrieved snippets to a third-party service.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

