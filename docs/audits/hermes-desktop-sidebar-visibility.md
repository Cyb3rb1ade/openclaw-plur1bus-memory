# Profile-scoped left navigation — local acceptance, 2026-09-06

The previous plugin registered a status-bar action and palette entry only. The
left `sidebar.nav` contribution had been removed with the unreliable experimental
route. Restoring a route would reintroduce the blank/chat rendering defect.

The host now accepts a direct `onSelect` sidebar contribution in addition to
existing route entries. It invokes the same stable plugin workspace as the status
bar and palette, without navigating the chat route. This generic host change is
preserved in `hermes-dashboard/patches/hermes-desktop-sidebar-action.patch` and
is not silently applied by the plugin installer.

The plugin reads the active backend's `memoryProviderEnabled` capability through
the existing explicit connection/profile transport. Navigation registrations are
added/removed on authoritative activation changes; late responses cannot affect
another profile. Transient failures keep only the current identity's last verified
entry. Selection, focus and a 15-second current-profile refresh reconcile changes.
Only the current profile is probed; no fleet-wide startup or config writes occur.

Verification:

- Actual distributed plugin ESM tests cover all three entry points, stable workspace
  identity, enabled/disabled profile switching, late replies and transient failure.
- Host: 35 sidebar/route/profile tests passed; renderer TypeScript check passed;
  full production renderer built and installed with its previous dist backed up.
- Port: 514 Python tests plus 55 subtests passed, including activation capability;
  lint, whitespace and installer preservation tests passed.
- Computer Use after a complete Desktop restart: left navigation entry visible;
  clicking it opens Bernhardine (13,105), Default (61), Bernd/main (9,086) and
  Heisenberg (672), each with its own partition. Coder and RapidMLX, without
  PLUR1BUS selected, have neither left nor status-bar PLUR1BUS navigation.

No memory/provider configuration changed. UI files were checksum-installed to
root plus all five existing profile homes. Only Desktop was restarted; the separate
messaging gateway remained running. This is a local install, not a public release.
