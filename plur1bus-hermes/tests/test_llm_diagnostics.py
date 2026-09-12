"""LLM failures stay useful without exposing provider text in normal logs."""

import errno
import io
import json
import os
import subprocess
import tempfile
import threading
import traceback
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.llm_backend import InternalLlmBackend
from plur1bus_hermes.llm_diagnostics import LlmErrorReporter, MAX_FILE_BYTES, classify_error


class Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.body


class ErrorCategoryTests(unittest.TestCase):
    def test_upstream_host_and_transport_categories_are_enums(self):
        cases = {
            "requires an injected runtime config scope": "no-config-scope",
            "Configured agent runtime is unavailable": "runtime-unavailable",
            "does not support isolated completion": "harness-unsupported",
            "isolated completion input was rejected": "input-rejected",
            "isolated completion output was rejected": "output-rejected",
            "isolated completion timed out": "host-timeout",
            "Plugin LLM completion was aborted": "host-aborted",
            "Plugin LLM completion failed": "host-failed",
            "AbortError": "aborted", "ETIMEDOUT": "timeout",
            "too many requests": "rate-limited", "quota exhausted": "quota",
            "unauthorized": "auth", "already running": "busy",
            "permission denied": "denied", "runtime closed": "unavailable",
            "fetch failed": "network", "internal server error": "server-error",
            "malformed request": "request-rejected", "something else": "other",
        }
        for message, expected in cases.items():
            with self.subTest(expected=expected):
                self.assertEqual(classify_error(RuntimeError(message))["errorHint"], expected)

    def test_http_status_wins_over_untrusted_reason_and_body_is_not_read(self):
        for status, expected in ((400, "request-rejected"), (401, "auth"), (403, "auth"),
                                 (408, "timeout"), (429, "rate-limited"), (503, "server-error")):
            error = urllib.error.HTTPError("http://secret.invalid", status, "abort malicious text", {}, io.BytesIO(b"body-secret"))
            result = classify_error(error)
            self.assertEqual(result["errorCode"], f"HTTP_{status}")
            self.assertEqual(result["errorHint"], expected)
            self.assertEqual(error.fp.tell(), 0)

    def test_exact_host_codes_and_os_codes_only(self):
        error = RuntimeError("untrusted raw message")
        for code, expected in (("LLM_COMPLETION_ABORTED", "host-aborted"),
                               ("LLM_RUNTIME_UNAVAILABLE", "runtime-unavailable")):
            error.code = code
            self.assertEqual(classify_error(error)["errorCode"], code)
            self.assertEqual(classify_error(error)["errorHint"], expected)
        for code in ("GenericCredential123", "sk-secret123456789", "BAD_CODE", 401):
            error.code = code
            self.assertNotIn("errorCode", classify_error(error))
        self.assertEqual(classify_error(OSError(errno.ECONNREFUSED, "secret"))["errorCode"], "ECONNREFUSED")
        self.assertEqual(classify_error(TimeoutError("secret"))["errorHint"], "timeout")
        self.assertEqual(classify_error(urllib.error.URLError("TLS handshake failed"))["errorHint"], "network")

    def test_windows_errno_alias_cannot_hide_canonical_allowed_code(self):
        with patch.dict(errno.errorcode, {errno.ECONNREFUSED: "WSAECONNREFUSED"}):
            self.assertEqual(classify_error(OSError(errno.ECONNREFUSED, "private error")),
                             {"errorClass": "ConnectionError", "errorHint": "network", "errorCode": "ECONNREFUSED"})

    def test_foreign_getters_and_custom_class_names_do_not_escape(self):
        class ForeignError(RuntimeError):
            @property
            def code(self):
                raise AssertionError("getter must not execute")

            @property
            def message(self):
                raise AssertionError("getter must not execute")

            def __str__(self):
                raise AssertionError("custom stringification must not execute")
        ForeignError.__name__ = "CredentialInClassName"
        result = classify_error(ForeignError("host unavailable"))
        self.assertEqual(result, {"errorClass": "RuntimeError", "errorHint": "unavailable"})


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.secret = "OpaqueProviderCredential123"
        self.config = {"llm": {"model": "model", "baseUrl": "http://test.invalid/v1", "apiKey": self.secret},
                       "llmRouter": {"errorDiagnostics": True}, "hermesHome": str(self.root / "profile")}

    def reporter(self, *, agent="alice", scope="private-alice", config=None, root=None):
        return LlmErrorReporter(self.config if config is None else config, agent,
                                data_dir=self.root if root is None else root, scope_key=scope)

    def files(self):
        return sorted(self.root.rglob("llm-router-errors.jsonl"))

    def test_default_off_and_non_boolean_opt_in_write_nothing(self):
        for flag in (None, False, "true", 1, {}):
            config = {**self.config, "llmRouter": {"errorDiagnostics": flag}}
            reporter = self.reporter(config=config)
            with self.assertLogs("plur1bus_hermes.llm_diagnostics") as logs:
                reporter.report(RuntimeError("private prompt " + self.secret), self.secret)
            self.assertNotIn(self.secret, "".join(logs.output))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_opt_in_redacts_all_error_fields_and_normal_log_has_no_raw_data(self):
        error = RuntimeError("private prompt fragment; key=" + self.secret + "\nBearer sk-notconfiguredlongsecret\nhttps://user:password@host/path?token=querysecret")
        error.name = self.secret
        error.code = self.secret
        with self.assertLogs("plur1bus_hermes.llm_diagnostics") as logs:
            self.reporter().report(error, self.secret)
        text = self.files()[0].read_text()
        normal = "".join(logs.output)
        for value in (self.secret, "sk-notconfiguredlongsecret", "user:password", "querysecret"):
            self.assertNotIn(value, text)
            self.assertNotIn(value, normal)
        self.assertNotIn("private prompt", normal)
        entry = json.loads(text)
        self.assertIn("private prompt fragment", entry["message"])
        self.assertEqual(entry["name"], "[REDACTED]")
        self.assertEqual(entry["code"], "[REDACTED]")
        self.assertEqual(entry["feature"], "unknown")

    def test_bare_configured_authorization_token_is_redacted_in_name_and_code(self):
        config = {**self.config, "headers": {"Authorization": "Bearer bare-opaque-secret"}}
        error = RuntimeError("bare-opaque-secret")
        error.name = "bare-opaque-secret"
        error.code = "bare-opaque-secret"
        self.reporter(config=config).report(error, "query-refinement")
        self.assertNotIn("bare-opaque-secret", self.files()[0].read_text())

    def test_known_nested_credentials_and_redaction_before_truncation(self):
        config = {**self.config, "llm": {**self.config["llm"],
            "headers": {"Authorization": "Bearer hidden-token"},
            "requestExtra": {"access_token": "SecondOpaqueCredential"}}}
        error = RuntimeError("x" * 505 + self.secret + " SecondOpaqueCredential hidden-token")
        error.name = "api_key='third-unconfigured-secret'"
        error.code = "Authorization: Bearer fourth-unconfigured-secret"
        self.reporter(config=config).report(error, "query-refinement")
        text = self.files()[0].read_text()
        for value in (self.secret[:6], "SecondOpaqueCredential", "third-unconfigured-secret", "fourth-unconfigured-secret"):
            self.assertNotIn(value, text)

    def test_diagnostics_are_bound_to_owner_profile_and_request_scope(self):
        reporters = [self.reporter(), self.reporter(agent="bob"), self.reporter(scope="shared-room"),
                     self.reporter(config={**self.config, "hermesHome": str(self.root / "other-profile")})]
        for index, reporter in enumerate(reporters):
            reporter.report(RuntimeError(f"failure-{index}"), "query-refinement")
        self.assertEqual(len(self.files()), 4)
        self.assertEqual({json.loads(path.read_text())["message"] for path in self.files()},
                         {f"failure-{index}" for index in range(4)})

    def test_missing_binding_and_invalid_owner_fail_closed(self):
        for reporter in (LlmErrorReporter(self.config, "alice"), self.reporter(scope=""), self.reporter(agent="../escape")):
            self.assertFalse(reporter.enabled)
            reporter.report(RuntimeError("failure"), "query-refinement")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_config_cannot_select_diagnostic_path_or_rebind_existing_reporter(self):
        forbidden = self.root / "forbidden.jsonl"
        config = {**self.config, "diagnosticsPath": str(forbidden),
                  "llmRouter": {"errorDiagnostics": True, "diagnosticsPath": str(forbidden)}}
        reporter = self.reporter(config=config)
        original = reporter._parts
        config["hermesHome"] = "different-profile"
        reporter.report(RuntimeError("bound error"), "query-refinement")
        self.assertFalse(forbidden.exists())
        self.assertEqual(reporter._parts, original)
        self.assertEqual(len(self.files()), 1)

    @unittest.skipIf(os.name == "nt", "Windows junction guard is tested separately")
    def test_root_replaced_by_symlink_after_binding_is_rejected(self):
        base = self.root / "data"
        base.mkdir()
        reporter = self.reporter(root=base)
        base.rename(self.root / "previous-data")
        outside = self.root / "outside"
        outside.mkdir()
        base.symlink_to(outside, target_is_directory=True)
        reporter.report(RuntimeError("private error"), "query-refinement")
        self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "POSIX FIFO contract")
    def test_nonregular_fifo_is_not_opened_as_a_blocking_log(self):
        reporter = self.reporter()
        reporter.report(RuntimeError("seed"), "query-refinement")
        path = self.files()[0]
        path.unlink()
        os.mkfifo(path)
        reporter.report(RuntimeError("failure"), "query-refinement")
        self.assertTrue(path.is_fifo())

    @unittest.skipIf(os.name == "nt", "Windows owner-only DACL is tested separately")
    def test_fixed_permissions_and_bounded_rotation(self):
        reporter = self.reporter()
        reporter.report(RuntimeError("first"), "query-refinement")
        path = self.files()[0]
        path.chmod(0o666)
        path.parent.chmod(0o777)
        for index in range(200):
            reporter.report(RuntimeError(f"failure-{index} " + "x" * 500), "query-refinement")
        backup = path.with_name(path.name + ".1")
        self.assertTrue(backup.exists())
        self.assertLessEqual(path.stat().st_size, MAX_FILE_BYTES)
        self.assertLessEqual(backup.stat().st_size, MAX_FILE_BYTES)
        for item in (path, backup, path.parent / ".lock"):
            self.assertEqual(item.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(set(item.name for item in path.parent.iterdir()), {path.name, backup.name, ".lock"})
        for line in path.read_text().splitlines() + backup.read_text().splitlines():
            json.loads(line)
        self.assertIn("failure-199", path.read_text())

    @unittest.skipIf(os.name == "nt", "Windows junction and hardlink guards are tested separately")
    def test_symlink_root_directory_file_and_rotation_are_not_followed(self):
        outside = self.root / "outside"
        outside.mkdir()
        victim = outside / "victim"
        victim.write_text("untouched")
        for target_kind in ("root", "directory", "file", "rotation", "lock", "hardlink"):
            with self.subTest(target_kind=target_kind):
                base = self.root / target_kind
                if target_kind == "root":
                    base.symlink_to(outside, target_is_directory=True)
                else:
                    base.mkdir()
                reporter = self.reporter(root=base)
                if target_kind == "directory":
                    (base / "diagnostics").symlink_to(outside, target_is_directory=True)
                elif target_kind not in ("root",):
                    reporter.report(RuntimeError("seed"), "query-refinement")
                    path = next(base.rglob("llm-router-errors.jsonl"))
                    target = path if target_kind in ("file", "hardlink") else path.with_name(path.name + ".1") if target_kind == "rotation" else path.parent / ".lock"
                    target.unlink(missing_ok=True)
                    if target_kind == "hardlink":
                        os.link(victim, target)
                    else:
                        target.symlink_to(victim)
                    if target_kind == "rotation":
                        path.write_bytes(b"x" * MAX_FILE_BYTES)
                reporter.report(RuntimeError("sensitive error"), "query-refinement")
                self.assertEqual(victim.read_text(), "untouched")

    def test_injected_write_or_logger_failures_do_not_replace_llm_error(self):
        reporter = self.reporter()
        with patch.object(reporter, "_append", side_effect=OSError("secret disk failure")), \
             patch("plur1bus_hermes.llm_diagnostics.LOGGER.warning", side_effect=RuntimeError("secret logger failure")), \
             patch("plur1bus_hermes.llm_diagnostics.LOGGER.debug", side_effect=RuntimeError("secret logger failure")):
            self.assertEqual(reporter.report(TimeoutError("provider secret"), "query-refinement")["errorHint"], "timeout")
        self.assertTrue(reporter._lock.acquire(blocking=False))
        reporter._lock.release()

    def test_thread_mutex_contention_skips_write_without_waiting_for_owner(self):
        reporter = self.reporter()
        completed = threading.Event()
        results = []

        def report():
            try:
                results.append(reporter.report(TimeoutError("private provider error"), "query-refinement"))
            finally:
                completed.set()

        reporter._lock.acquire()
        thread = threading.Thread(target=report)
        with patch.object(reporter, "_append") as append:
            thread.start()
            try:
                self.assertTrue(completed.wait(timeout=1), "LLM failure waited on a contended diagnostic mutex")
                append.assert_not_called()
            finally:
                reporter._lock.release()
                thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [{"errorClass": "TimeoutError", "errorHint": "timeout"}])
        self.assertEqual(self.files(), [])
        reporter.report(TimeoutError("later failure"), "query-refinement")
        self.assertEqual(len(self.files()), 1)

    def test_locked_diagnostic_file_does_not_block_operation(self):
        from plur1bus_hermes import file_lock
        reporter = self.reporter()
        reporter.report(RuntimeError("seed"), "query-refinement")
        path = self.files()[0]
        before = path.read_bytes()
        lock = file_lock.open_lock(path.parent / ".lock")
        try:
            file_lock.flock(lock, file_lock.LOCK_EX | file_lock.LOCK_NB)
            reporter.report(RuntimeError("blocked"), "query-refinement")
        finally:
            os.close(lock)
        self.assertEqual(path.read_bytes(), before)

    def test_rotation_bound_and_json_records_on_each_platform(self):
        reporter = self.reporter()
        for index in range(200):
            reporter.report(RuntimeError(f"failure-{index} " + "x" * 500), "query-refinement")
        path = self.files()[0]
        backup = path.with_name(path.name + ".1")
        self.assertTrue(backup.is_file())
        for item in (path, backup):
            self.assertLessEqual(item.stat().st_size, MAX_FILE_BYTES)
            for line in item.read_text().splitlines():
                json.loads(line)
        self.assertIn("failure-199", path.read_text())

    @unittest.skipUnless(os.name == "nt", "Requires real Windows security APIs")
    def test_windows_files_have_protected_owner_only_acl(self):
        import ctypes
        from ctypes import wintypes
        from plur1bus_hermes.llm_diagnostics_windows import _WindowsFiles
        reporter = self.reporter()
        reporter.report(RuntimeError("private diagnostic"), "query-refinement")
        path = self.files()[0]  # A silent fail-open skip is a test failure.
        security = _WindowsFiles()
        try:
            sid = security.sid
            # Read the existing ACL through independent, non-mutating Win32
            # APIs. Do not rely on an external PowerShell executable/runtime.
            read_acl = security.security.GetNamedSecurityInfoW
            read_acl.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                 ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                 ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
            read_acl.restype = wintypes.DWORD
            render_acl = security.security.ConvertSecurityDescriptorToStringSecurityDescriptorW
            render_acl.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
            render_acl.restype = wintypes.BOOL
            get_ace = security.security.GetAce
            get_ace.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
            get_ace.restype = wintypes.BOOL
            for target in (path, path.parent, path.parent / ".lock"):
                descriptor = ctypes.c_void_p()
                rendered = wintypes.LPWSTR()
                owner = ctypes.c_void_p()
                dacl = ctypes.c_void_p()
                try:
                    self.assertEqual(read_acl(str(target), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None,
                                              ctypes.byref(descriptor)), 0)
                    self.assertTrue(render_acl(descriptor, 1, 5, ctypes.byref(rendered), None),
                                    f"ACL rendering failed: {ctypes.get_last_error()}")
                    sddl = rendered.value
                    self.assertIn("D:P", sddl)
                    # Exactly one access-allowed ACE, assigned to the process user.
                    self.assertEqual(sddl.count("(A;"), 1)
                    self.assertEqual(sddl.count(";;;"), 1)
                    self.assertEqual(security._sid_text(owner), sid)
                    # SDDL may abbreviate RID500 as LA. Compare the actual
                    # ACCESS_ALLOWED_ACE SID, not its display alias. The SID
                    # follows the 4-byte ACE_HEADER and 4-byte ACCESS_MASK.
                    ace = ctypes.c_void_p()
                    self.assertTrue(get_ace(dacl, 0, ctypes.byref(ace)))
                    self.assertEqual(ctypes.c_ubyte.from_address(ace.value).value, 0)
                    self.assertEqual(security._sid_text(ctypes.c_void_p(ace.value + 8)), sid)
                finally:
                    if rendered:
                        security.kernel.LocalFree(ctypes.cast(rendered, ctypes.c_void_p))
                    if descriptor:
                        security.kernel.LocalFree(descriptor)
        finally:
            security.close()

    @unittest.skipUnless(os.name == "nt", "Requires Windows junctions and security APIs")
    def test_windows_junctions_and_hardlinks_are_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        base = self.root / "junction-root"
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(base), str(outside)],
                       check=True, capture_output=True)
        reporter = self.reporter(root=base)
        self.assertFalse(reporter.enabled)
        reporter.report(RuntimeError("private error"), "query-refinement")
        self.assertEqual(list(outside.iterdir()), [])
        safe_root = self.root / "safe-root"
        safe_root.mkdir()
        reporter = self.reporter(root=safe_root)
        subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(safe_root / "diagnostics"), str(outside)],
                       check=True, capture_output=True)
        reporter.report(RuntimeError("private error"), "query-refinement")
        self.assertEqual(list(outside.iterdir()), [])
        reporter = self.reporter()
        reporter.report(RuntimeError("seed"), "query-refinement")
        path = next((self.root / "diagnostics").rglob("llm-router-errors.jsonl"))
        path.unlink()
        victim = outside / "victim"
        victim.write_text("untouched")
        os.link(victim, path)
        reporter.report(RuntimeError("private error"), "query-refinement")
        self.assertEqual(victim.read_text(), "untouched")

    def test_windows_append_control_flow_with_portable_fake_handles(self):
        from plur1bus_hermes import llm_diagnostics_windows as windows
        events = []
        class Files:
            def directory(self, path, *, create):
                events.append(("directory", str(path), create))
                if create:
                    path.mkdir(exist_ok=True)
            def file(self, path):
                events.append(("file", path.name))
                return os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
            def close(self):
                events.append(("close",))
        root = self.root
        with patch.object(windows, "_WindowsFiles", Files):
            windows.append_windows(root, ("scoped",), b"first\n", 20)
            windows.append_windows(root, ("scoped",), b"second-long-record\n", 20)
        self.assertEqual((root / "scoped" / "llm-router-errors.jsonl.1").read_bytes(), b"first\n")
        self.assertEqual((root / "scoped" / "llm-router-errors.jsonl").read_bytes(), b"second-long-record\n")
        self.assertEqual(events[-1], ("close",))

    def test_runtime_wiring_keeps_binding_without_enabling_diagnostics_by_default(self):
        from plur1bus_hermes.runtime import Plur1busRuntime
        runtime = Plur1busRuntime(self.root, self.config, "alice")
        try:
            reporter = runtime._internal_llm._errors
            self.assertTrue(reporter.enabled)
            reporter.report(RuntimeError("runtime-bound"), "query-refinement")
            self.assertEqual(len(self.files()), 1)
            expected = self.reporter(scope=runtime.scope_key)
            self.assertEqual(reporter._parts, expected._parts)
        finally:
            runtime.shutdown()

    def test_provider_binds_shared_absolute_root_to_host_home_and_unaliased_profile(self):
        from plur1bus_hermes.provider import Plur1busMemoryProvider
        config = {**self.config, "dataDir": str(self.root / "shared"), "hermesHome": "untrusted-home",
                  "_hermesProfile": "untrusted-profile", "agentAliases": {"alpha": "same-owner", "beta": "same-owner"},
                  "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
                  "reranker": {"provider": "disabled"}}
        provider = Plur1busMemoryProvider(config)
        bindings = []
        try:
            for home, profile in ((self.root / "host-a", "alpha"), (self.root / "host-a", "beta"),
                                  (self.root / "host-b", "alpha")):
                provider.initialize("session", hermes_home=home, agent_identity=profile)
                self.assertEqual(provider._runtime.agent_id, "same-owner")
                self.assertEqual(provider._runtime.config["hermesHome"], str(home))
                self.assertEqual(provider._runtime.config["_hermesProfile"], profile)
                reporter = provider._runtime._internal_llm._errors
                reporter.report(RuntimeError(profile), "query-refinement")
                bindings.append(reporter._parts)
            self.assertEqual(len(set(bindings)), 3)
            self.assertEqual(len(self.files()), 3)
            self.assertEqual(provider.config["hermesHome"], "untrusted-home")
        finally:
            provider.shutdown()

    def test_windows_writer_dispatch_and_failure_are_fail_open(self):
        from plur1bus_hermes import llm_diagnostics_windows
        with patch("plur1bus_hermes.llm_diagnostics._WINDOWS", True), \
             patch.object(llm_diagnostics_windows, "append_windows", side_effect=OSError("secret Win32 failure")) as append:
            reporter = self.reporter()
            self.assertEqual(reporter.report(TimeoutError("provider failure"), "query-refinement")["errorHint"], "timeout")
            append.assert_called_once()
            self.assertEqual(append.call_args.args[0], self.root)
            self.assertEqual(append.call_args.args[1], reporter._parts)
            self.assertEqual(append.call_args.args[3], MAX_FILE_BYTES)


class BackendDiagnosticsTests(unittest.TestCase):
    def test_http_failure_has_safe_logs_and_traceback_and_opt_in_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = "OpaqueCredential"
            error = urllib.error.HTTPError("http://user:pass@private/v1?key=secret", 429,
                                           "prompt fragment " + secret, {}, io.BytesIO(b"sensitive response body"))
            def opener(*args, **kwargs):
                raise error
            backend = InternalLlmBackend({"llm": {"model": "test", "apiKey": secret},
                "llmRouter": {"errorDiagnostics": True}}, "alice", opener=opener, data_dir=root, scope_key="private")
            with self.assertLogs("plur1bus_hermes.llm_diagnostics") as logs:
                try:
                    backend.complete_json("query-refinement", "system prompt", "user prompt")
                except RuntimeError:
                    rendered = traceback.format_exc()
                else:
                    self.fail("transport error must remain an error")
            for value in (secret, "prompt fragment", "user:pass", "sensitive response body"):
                self.assertNotIn(value, rendered + "".join(logs.output))
            self.assertIn("rate-limited", rendered)
            entry = json.loads(next(root.rglob("llm-router-errors.jsonl")).read_text())
            self.assertEqual(entry["errorCode"], "HTTP_429")
            self.assertIn("prompt fragment", entry["message"])
            self.assertNotIn(secret, entry["message"])
            self.assertEqual(error.fp.tell(), 0)

    def test_native_python_exception_uses_safe_host_code_without_new_transport(self):
        error = RuntimeError("native error private prompt")
        error.code = "LLM_COMPLETION_ABORTED"
        def opener(*args, **kwargs):
            raise error
        backend = InternalLlmBackend({"llm": {"model": "test"}}, "alice", opener=opener)
        with self.assertLogs("plur1bus_hermes.llm_diagnostics") as logs:
            with self.assertRaisesRegex(RuntimeError, "host-aborted"):
                backend.complete_json("query-refinement", "system", "user")
        self.assertIn("LLM_COMPLETION_ABORTED", "".join(logs.output))
        self.assertNotIn("private prompt", "".join(logs.output))

    def test_invalid_response_shape_and_unconfigured_backend_remain_safe(self):
        for content in (b"bad json", b"{}", b"[]", b'{"choices": []}', b'{"choices":[{"message":{"content":"[]"}}]}'):
            backend = InternalLlmBackend({"llm": {"model": "test"}}, "alice", opener=lambda *a, **k: Response(content))
            with self.assertRaisesRegex(RuntimeError, "output-rejected"):
                backend.complete_json("query-refinement", "system", "user")
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            InternalLlmBackend({}, "alice").complete_json("query-refinement", "system", "user")

    def test_success_has_no_diagnostic_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            response = Response(json.dumps({"choices": [{"message": {"content": '{"query":"good"}'}}]}).encode())
            backend = InternalLlmBackend({"llm": {"model": "test"}, "llmRouter": {"errorDiagnostics": True}},
                "alice", opener=lambda *a, **k: response, data_dir=root, scope_key="private")
            self.assertEqual(backend.complete_json("query-refinement", "system", "user"), {"query": "good"})
            self.assertEqual(list(root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
