# Task 3 report

Implemented managed lifecycle consent and cancel-before-stop in macOS setup and guided console, progress and checked recovery, truthful outcomes, Desktop opt-in guidance and German localization. Swift runner drains bounded protocol lines after process exit before completion. Automatic recovery rediscovers PM Python. Manual externally stopped console mode remains explicit.

RED (after extracting the existing runner unchanged, with event fields added):

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /private/tmp/plur1bus-7193-release.7shDfJty/venv/bin/python -m unittest distribution.tests.test_macos_lifecycle_runner -v
```

`FAIL: test_drains_long_final_event_before_completion`: actual `['DONE']`, expected `['EVENT:installed-restart-failed', 'DONE']`. The real short-lived Python subprocess emitted a 12 KB final event.

GREEN:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /private/tmp/plur1bus-7193-release.7shDfJty/venv/bin/python -m unittest distribution.tests.test_macos_lifecycle_runner distribution.tests.test_macos_setup distribution.tests.test_macos_localization distribution.tests.test_installer -q
```

`Ran 64 tests in 47.665s` / `OK` (before adding two subsequent focused console failure tests and final bounded-parser refinement).

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /private/tmp/plur1bus-7193-release.7shDfJty/venv/bin/python -m unittest distribution.tests.test_macos_lifecycle_runner distribution.tests.test_macos_setup distribution.tests.test_macos_localization distribution.tests.test_installer.InstallerTests.test_guided_defaults_select_all_and_activation_but_do_not_apply_without_confirmation distribution.tests.test_installer.InstallerTests.test_guided_install_authorizes_managed_lifecycle distribution.tests.test_installer.InstallerTests.test_guided_manual_mode_remains_explicit distribution.tests.test_installer.InstallerTests.test_guided_restart_failure_offers_checked_retry distribution.tests.test_installer.InstallerTests.test_guided_partial_failure_never_offers_retry -q
```

`Ran 11 tests in 2.374s` / `OK`. Includes system language de/de-DE/en/en-GB and French English fallback, real long child output, cancellation, managed/manual choice and safe retry eligibility.

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -parse-as-library -swift-version 5 -target arm64-apple-macosx13.0 distribution/macos/{Setup,HermesPython,Localization,InstallerRunner}.swift -o /tmp/plur1bus-task3-setup
```

Exit 0. `git diff --check` exit 0.

Limitations: no productive or QA Hermes process was stopped or restarted. Packaged GUI interaction, actual isolated runtime lifecycle, signing/notarization and platform acceptance remain with release owner. Native Swift regression covers real child I/O; GUI outcome presentation and PM rediscovery are not yet independently exercised through a native UI automation test.
