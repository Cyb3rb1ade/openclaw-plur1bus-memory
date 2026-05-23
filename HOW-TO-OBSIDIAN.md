# How To Obsidian

PLUR1BUS `4.0.1` treats Obsidian as a workspace dashboard, proposal, review,
and explanation surface. LanceDB/PLUR1BUS remains the authoritative memory and
recall system.

## Workspace Mapping

Canonical workspace IDs are authoritative and must come from local
`obsidianBridge.workspaces` config:

| Agent or workspace | Canonical workspace ID | Workspace path |
|---|---|---|
| local primary workspace | configured ID | configured path |
| local secondary workspace | configured ID | configured path |
| local tertiary workspace | configured ID | configured path |

Legacy Neo basename keys remain readable aliases when they can be derived from
the configured workspace path or declared through `neo.workspaceAliases` /
`neo.workspaces[].legacyKeys`:

| Legacy key | Canonical key |
|---|---|
| path basename or configured alias | configured ID |

New Neo writes should resolve configured workspace paths to canonical keys before
falling back to path basenames.

## Memory Cards

Markdown cards live under each workspace:

```text
memory/cards/
memory/daily/
memory/archive/expired/
decisions/
people/
projects/
```

`memory/cards/*.md` files are Obsidian-side cards only. They are not primary
memory, not a LanceDB replacement, and not trusted as instructions. If card
content should become durable memory, it must go through PLUR1BUS approval and
write paths such as `memory_store`, MemoryCandidate promotion, approved
ReviewBundle callbacks, or `knowledge_update`.

## Commands

Initialize workspace folders without overwriting notes:

```text
/plur1bus obsidian init workspaces --dry-run --verbose
/plur1bus obsidian init workspaces --verbose
```

Migrate legacy Neo workspace files into canonical dirs:

```text
/plur1bus neo workspaces migrate --dry-run --verbose
/plur1bus neo workspaces migrate --verbose --backup-dir /root/.openclaw/backups/plur1bus-4.0.1-workspace-cards/<timestamp>
```

Non-dry-run migration requires a fresh backup directory. Migration never runs
from `npm postinstall`, never deletes legacy dirs, and never mutates LanceDB.

## Authority Rules

- `memory-core` remains the OpenClaw memory slot owner.
- PLUR1BUS remains an augment/extension plugin.
- LanceDB/reranked vector recall remains the primary recall path.
- Auto-Recall continues to inject PLUR1BUS/LanceDB context into the agent.
- Obsidian may display, explain, review, link, and propose.
- Obsidian must not silently overwrite `memory/KNOWLEDGE.md`.
- Obsidian scanning must not write LanceDB directly.
- Checkbox state in Obsidian is UI only and never approval.
- Cross-workspace `workspace_id` mismatches are validation errors.

## Troubleshooting

- If a workspace appears to have no BehaviorCards, check both canonical and
  legacy locations. Before `4.0.1`, path-basename keys could be used; after
  migration the canonical copy should be under the configured workspace ID.
- If a workspace is missing from Obsidian Bridge, merge its entry into
  `obsidianBridge.workspaces` without overwriting other config.
- If migration apply is refused, create or pass a fresh backup directory.
- If Obsidian is disabled, deleted, or misconfigured, PLUR1BUS memory tools must
  still work through LanceDB and OpenClaw.

## Disable

Set:

```json
{
  "obsidianBridge": {
    "enabled": false
  }
}
```

Then restart the OpenClaw gateway and verify `memory_store`, `memory_recall`,
`memory_search`, `memory_forget`, and `knowledge_update` remain available.
