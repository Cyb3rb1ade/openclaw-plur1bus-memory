"""Canonical command catalog shared by `/plur1bus` handlers."""

CANONICAL_SUBCOMMANDS = [
    "start",
    "setup",
    "enable",
    "disable",
    "status",
    "memory",
    "forget",
    "correct",
    "feedback",
    "share",
    "features",
    "graph",
    "code",
    "critical",
    "speakers",
    "temperament",
    "dreams",
    "obsidian",
    "reminders",
    "jobs",
    "doctor",
    "parity",
    "migrate",
]


def build_command_table() -> dict[str, dict]:
    return {name: {"description": f"PLUR1BUS command: {name}"} for name in CANONICAL_SUBCOMMANDS}


def is_alias_candidate(command: str) -> bool:
    return command in {"forget", "correct", "mf", "share"}
