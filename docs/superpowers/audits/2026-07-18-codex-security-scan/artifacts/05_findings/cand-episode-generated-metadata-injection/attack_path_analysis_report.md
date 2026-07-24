# Attack-path analysis — Episode LLM output is persisted as unsanitized Neo and YAML/Markdown metadata

Candidate: `cand-episode-generated-metadata-injection`

## Path

1. **Source / trust boundary:** Untrusted conversation turns influence narrative LLM JSON fields.
2. **Nearest or broken control:** JSON parsing exists and filename characters are stripped, but field types, lengths, enum membership, newlines, and YAML quoting are not validated.
3. **Sink:** Generated episode metadata is appended to Neo storage and written verbatim into an automatically generated Markdown note/frontmatter.
4. **Security outcome if exploitable:** A crafted conversation/model response can forge note metadata or plant prompt-like persistent content that enters later review, graph, or recall workflows.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

