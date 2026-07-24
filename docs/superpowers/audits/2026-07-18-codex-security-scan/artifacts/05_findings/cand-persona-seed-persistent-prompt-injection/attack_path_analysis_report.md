# Attack-path analysis — Workspace identity content can become a persistent imperative persona directive

Candidate: `cand-persona-seed-persistent-prompt-injection`

## Path

1. **Source / trust boundary:** On a workspace without persona-voice.md, the default-enabled startup path reads SOUL.md, IDENTITY.md, or AGENT.md and sends their raw content as identity hints to the configured LLM. These workspace files can be supplied by an imported/untrusted workspace or altered by a party with workspace-content write access.
2. **Nearest or broken control:** The seed parser checks only that at least three response lines begin with '- '. It does not constrain bullets to style attributes, remove imperative content, mark source material untrusted, or require a user confirmation before persisting the generated directive.
3. **Sink:** writePersonaVoice persists the generated bullets; loadPersonaDirective converts them to 'Deine Grundstimme (befolge sie...)' and index.js places that directive ahead of normal recalled-memory context on future model turns.
4. **Security outcome if exploitable:** A successful seed-time instruction injection can survive across turns and steer the agent's behavior, rather than remaining a one-turn untrusted document effect. It can also influence the emoji/reaction palette derived from the same managed block.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

