# Neo MainThread Drain Design

## Goal

Keep PLUR1BUS Neo Capture and embedding-status drain fully functional while removing synchronous full-file work from the OpenClaw Gateway hot path.

## Problem

The `agent_end` hook currently runs Neo Capture and `drainEmbeddingQueue()` inline. Capture writes several JSONL files synchronously. The drain then reads the whole queue, reads all target JSONL files to build by-id maps, appends fresh target records, and rewrites the whole queue. On long sessions where `event.messages` contains the full history, one run can capture hundreds of turns and enqueue hundreds of low-impact embedding-status items. This blocks the Node.js Gateway MainThread and produces multi-second event-loop stalls.

The drain does not call OpenAI embeddings. It is freshness bookkeeping for Neo shadow records.

## Design

Introduce an asynchronous Neo runtime path around the existing Neo store:

- `agent_end` should enqueue a small capture job and return quickly.
- A background scheduler should process capture jobs after the hook returns.
- Capture should remain functionally equivalent: turns, memory candidates, reactions, behavior cards, and queue entries are still produced.
- Capture should become idempotent using deterministic record IDs and append-time dedupe so repeated full-history `event.messages` input does not append old turns again.
- Drain should run outside the hook and avoid whole-queue rewrites when possible.

The first implementation phase keeps JSONL as the durable audit format and introduces deterministic IDs plus non-blocking scheduling. It does not change the user-visible Neo feature set and does not require data migration.

## Architecture

Add focused runtime modules:

- `lib/neo-worker-runtime.js`
  - owns a long-lived Worker Thread,
  - serializes Neo capture/drain jobs by posting them to the worker,
  - exposes pressure-aware limits,
  - keeps errors logged without throwing into the OpenClaw hook.
- `lib/neo-worker-runner.js`
  - runs inside the Worker Thread,
  - creates the Neo store for the resolved workspace,
  - executes `recordHook`, `captureNeoFromAgentEnd`, and `drainEmbeddingQueue`.

Extend `lib/neo-arch.js`:

- deterministic IDs for turns/candidates/reactions/behavior cards,
- append-time dedupe by `id`,
- optional capture/drain limits that preserve eventual processing.

Update `index.js`:

- create the runtime once during plugin registration,
- replace inline capture/drain in `agent_end` with `neoRuntime.enqueueAgentEnd(...)`,
- keep logging but make hook latency bounded.

## Data Flow

1. `agent_end` receives `event` and `ctx`.
2. `index.js` posts a Neo job to the Worker Thread and awaits the worker promise inside the existing capture scheduler.
3. The Worker Thread resolves the workspace and store.
4. The worker calls `captureNeoFromAgentEnd(...)`.
5. New deterministic records are appended only if their IDs are not already present in the recent store window.
6. The worker runs the existing drain outside the Gateway MainThread.
7. Logs report capture and drain counts asynchronously.

## Error Handling

Neo runtime errors are logged through `api.logger.warn` and do not fail the agent run. Existing JSONL files remain the durable source. If the process restarts before a worker job completes, the next `agent_end` with full history can replay the missed capture because deterministic IDs make replay idempotent.

## Testing

Add unit-level DB-free tests:

- capture replay with the same messages does not duplicate records,
- deterministic IDs remain stable for equivalent message input,
- Worker runtime resolves asynchronously without running capture/drain on the Gateway MainThread,
- Worker runner returns capture/drain counts,
- existing low-impact drain behavior still marks queue entries done/fresh.

Run:

```bash
node --test tests/*.test.js
```
