# PLUR1BUS Controls for Hermes

This package contains the installable Hermes-side controls runtime for:

- `/plur1bus` canonical command surface
- Session / hook registration bridge
- Shared service container adapters
- Passive lifecycle-hook registration

The controls layer registers only `/plur1bus`; it deliberately does not shadow
Hermes built-ins such as `/memory`, `/state`, `/enable`, or `/disable`. The
subcommands that mutate PLUR1BUS data remain unavailable until their archive-first
domain handlers are ported.
