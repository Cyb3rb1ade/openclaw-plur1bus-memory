# Operational live-verification runbook

Use this runbook when recalled memory suggests changing operational or live
system state (cronjobs, systemd services, timers, deployment/protect scripts,
database migrations, etc.). Recalled memory is historical evidence and may be
stale or missing timestamps. Verify the current state on the target host before
acting.

## When to use

- The recalled memory contains operational keywords (`cron`, `systemctl`,
  `service`, `deploy`, `production`, `live`, `journalctl`, etc.).
- The memory is older than 2 hours (`freshness="stale"`) or has no timestamp
  (`freshness="unknown"`).
- The prompt asks to disable, stop, delete, edit, or otherwise change anything
  operational.

## Quick checks by area

### Cron (user-level)

```bash
# List current crontab for the deployment user
crontab -l

# Check cron spool and at jobs (requires sudo/root)
ls -la /var/at/tabs/          # macOS
ls -la /var/spool/cron/crontabs/  # Linux

# Look for duplicate cronjob names or overlapping schedules
# Search for the job name in the crontab output.
```

### systemd (user-level)

```bash
# Status of all user timers/services
systemctl --user list-timers --all
systemctl --user list-units --type=service --all

# Status of a specific service/timer
systemctl --user status <service-or-timer>

# Recent logs
journalctl --user --unit=<unit> --since "1 hour ago"
```

### Deployment / protect / update scripts

```bash
# Locate the script in the repo and on disk
find /path/to/deploy -name "*.sh" -o -name "protect*" -o -name "update*"

# Inspect current content before running anything
cat <script>

# Check git status / recent changes
git -C <repo> status
git -C <repo> log --oneline -5
```

### Database migrations / schema changes

```bash
# Confirm current schema version and pending migrations
<your-migration-tool> status

# Read the migration file before applying
cat migrations/<pending>.sql
```

### General state

```bash
# Is the expected file/service/config actually present?
ls -la <path>
stat <path>

# Is a process running?
ps aux | grep -i <pattern>
```

## Decision gate

Before changing anything operational:

1. Confirm the state matches the recalled memory.
2. If the state is different, treat the memory as outdated and do not apply it.
3. If the state matches but the memory is stale, verify the change is still
   desired and safe.
4. Document the verification step in the agent trace or chat turn.

## Related tests

- `tests/operational-action-guard.test.js` — regression tests for the prompt-level
  operational warning.
- `tests/temporal-provenance.test.js` — unit tests for age, freshness, risk
  classification.
