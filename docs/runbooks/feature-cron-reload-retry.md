# Feature cron reload retry

PLUR1BUS 7.18.30 handles brief plugin-generation gaps in the external feature-cron client. Each attempt sends `plur1bus.feature.run` through the public OpenClaw CLI Gateway SDK; it does not reuse an old plugin handler or run feature work locally.

Retry requires all three observed response properties:

- Error name `GatewayClientRequestError`.
- Gateway code `UNAVAILABLE`.
- Exact message `PluginInstanceUnavailableError: Plugin memory-lancedb-namespaced was reloaded or disabled; use its current tools.`

There are at most four RPC attempts: the initial call and three retries after 5, 10 and 15 seconds. These waits add at most 30 seconds; RPC execution retains its existing 540-second timeout. A replacement that remains unavailable after the last attempt causes the original error to propagate. Disabling the plugin can produce the same rejection and therefore exhausts this finite window rather than retrying indefinitely.

Permission denials, generic availability errors, transport timeouts, other plugins, malformed replies, feature-handler failures and mutation-policy denials do not trigger retry. Work admitted to the feature handler reports failures with `plur1bus_feature_cron_error`, outside the retry predicate. The installed host's first-response handling also prevents a later outer retirement error from replaying an already-completed call. An independent reproduction using the real host `PluginInstance` and the real handler verified that business work executes once and successful `NO_REPLY` is sent before a later retirement error.

Intermediate rejections emit no client stdout or stderr. The host combines both streams for cron delivery, so even a stderr warning could otherwise turn a successful `NO_REPLY` into an unwanted notification. Server-side RPC diagnostics still record rejected attempts. Successful output and final errors retain their existing behavior.

The feature schedules, job payloads, credentials, model assignments, permissions, caches and memory data do not change. Existing native feature jobs use the fixed installed `scripts/run-feature-cron.mjs` path and pick up the client fix on their next process start. An already-running client retains the code it originally loaded.
