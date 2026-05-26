# How To Obsidian

PLUR1BUS `4.2.x` treats Obsidian as a workspace dashboard, proposal, review,
and explanation surface. LanceDB/PLUR1BUS remains the authoritative memory and
recall system.

There is no required standalone `plur1bus` shell binary. The user-facing
interface is the OpenClaw plugin/slash-command surface.

## Normal User Flow

Use the short commands in Telegram or any OpenClaw command channel:

```text
/plur1bus_morning
/plur1bus_evening
/plur1bus_review
/plur1bus_review approve low-risk
/plur1bus_review apply
```

Meaning:

- `/plur1bus_morning` prepares daily review proposals.
- `/plur1bus_evening` runs the deeper evening checks and writes an artifact.
- `/plur1bus_review` shows the latest pending ReviewBundle.
- `/plur1bus_review approve low-risk` marks low-risk pending items as approved.
- `/plur1bus_review reject all` marks pending items as rejected.
- `/plur1bus_review apply` is the only step that writes approved items to
  memory.

Morning, evening, review, and approve do not write memory. Approval only marks
items. Apply re-reads the ReviewBundle, revalidates hashes/preconditions, and
applies approved safe items.

## What PLUR1BUS Shows

Telegram summaries are intentionally compact. Full item details stay in the
ReviewBundle artifact under:

```text
plur1bus/review-bundles/
```

Summaries should separate:

- Obsidian notes to import: user Vault notes proposed as MemoryCandidates.
- Vault hygiene / generated artifacts: cleanup or generated-file maintenance.
- Blockers / warnings: safety or consistency issues that require attention.

The dashboard `plur1bus/dashboards/review-queue.md` is a generated
`review_item` record dashboard. It is not the authoritative ReviewBundle queue.
If it shows `0` records, still use `/plur1bus_review` to check pending
ReviewBundle items.

## Advanced Commands

The long command namespace remains available:

```text
/plur1bus obsidian doctor
/plur1bus obsidian review prepare
/plur1bus obsidian review show <bundleId>
/plur1bus obsidian review approve <bundleId> --items <ids|all|low-risk>
/plur1bus obsidian review reject <bundleId> --items <ids|all>
/plur1bus obsidian review snooze <bundleId> --items <ids> --until <date|duration>
/plur1bus obsidian review apply <bundleId>
/plur1bus obsidian morning-review
/plur1bus obsidian evening-review
/plur1bus obsidian conflicts
/plur1bus obsidian records rebuild
/plur1bus obsidian dashboards build
/plur1bus obsidian bases build
/plur1bus obsidian semantic-conflicts build
/plur1bus obsidian duplicates scan
/plur1bus obsidian provenance build
/plur1bus obsidian impact analyze <memoryId|project|all>
/plur1bus obsidian links suggest
/plur1bus obsidian project-hub <topic>
/plur1bus obsidian memory explain <id> --deep
/plur1bus obsidian weekly build
/plur1bus obsidian soul patch
```

## Multi-Workspace Setup

Configured workspaces come from `obsidianBridge.workspaces[]`:

```json
{
  "obsidianBridge": {
    "enabled": true,
    "watch": true,
    "workspaces": [
      {
        "workspace_id": "main",
        "agent_id": "main",
        "path": "~/.openclaw/workspace",
        "label": "Main"
      }
    ]
  }
}
```

Initialize configured workspace folders without overwriting notes:

```text
/plur1bus obsidian init workspaces --dry-run --verbose
/plur1bus obsidian init workspaces --workspace <id> --verbose
/plur1bus obsidian init workspaces --agent <agentId> --verbose
```

Print or install per-workspace Morning Review and Evening Deep Review jobs:

```text
/plur1bus obsidian cron print-workspace-reviews --all
/plur1bus obsidian cron install-workspace-reviews --force --workspace <id>
/plur1bus obsidian cron install-workspace-reviews --force --agent <agentId>
```

OpenClaw Cron is the supported scheduler. The generated cron prompts execute
the PLUR1BUS plugin command before model inference; they must not look for a
standalone shell CLI.

## Authority Rules

- `memory-core` remains the OpenClaw memory slot owner.
- PLUR1BUS remains an augment/extension plugin.
- LanceDB/reranked vector recall remains the primary recall path.
- Auto-Recall continues to inject PLUR1BUS/LanceDB context into the agent.
- Obsidian may display, explain, review, link, and propose.
- Obsidian notes are untrusted input until reviewed and applied.
- Obsidian scanning must not write LanceDB directly.
- Obsidian must not silently overwrite `memory/KNOWLEDGE.md`.
- Checkbox state in Obsidian is UI only and never approval.
- Cross-workspace `workspace_id` mismatches are validation errors.

## Workspace Mapping

Canonical workspace IDs are authoritative and must come from local
`obsidianBridge.workspaces` config.

Legacy Neo basename keys remain readable aliases when they can be derived from
the configured workspace path or declared through `neo.workspaceAliases` /
`neo.workspaces[].legacyKeys`.

New Neo writes should resolve configured workspace paths to canonical keys
before falling back to path basenames.

## Vault Content

Human-authored Markdown can live anywhere in the workspace Vault. Generated
PLUR1BUS artifacts live under:

```text
plur1bus/
  README.md
  dashboards/
  records/
  review-bundles/
  proposals/
  doctor/
  conflicts/
  memory-explanations/
  stale-knowledge/
  project-hubs/
  provenance/
  impact-analysis/
  semantic-conflicts/
  duplicate-candidates/
  weekly/
  tasks/
  managed-blocks.log.jsonl
```

Machine-managed Markdown is changed only inside PLUR1BUS managed blocks. Human
text outside managed blocks is not overwritten. If a managed block hash does not
match, PLUR1BUS reports a warning/conflict instead of silently replacing it.

## Troubleshooting

- If `/plur1bus_review` says no ReviewBundle exists, run `/plur1bus_morning`
  or `/plur1bus_evening` first.
- If a dashboard says `0` pending but `/plur1bus_review` shows pending items,
  trust `/plur1bus_review` for ReviewBundles. The dashboard is a static record
  view.
- If a workspace is missing, check `obsidianBridge.workspaces[]`, then run
  `init workspaces` for the selected workspace or agent.
- If Obsidian is disabled, deleted, or misconfigured, PLUR1BUS memory tools
  must still work through LanceDB and OpenClaw.

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
