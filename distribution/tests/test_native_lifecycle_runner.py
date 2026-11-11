import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest


path = Path(__file__).with_name('native_lifecycle_runner.py')
spec = importlib.util.spec_from_file_location('native_lifecycle_runner', path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_failed_fixture_retains_diagnostics_and_preserves_failure(tmp_path):
    fixture = tmp_path / 'failing_fixture.py'
    fixture.write_text('''import pathlib, sys
parent = pathlib.Path(sys.argv[sys.argv.index("--sandbox-parent") + 1])
sandbox = parent / "plur1bus-runtime-acceptance-test"
sandbox.mkdir()
(sandbox / "gateway.log").write_text("gateway failed")
(sandbox / "runtime-receipt.json").write_text('{"state":"paused"}')
(sandbox / "startup-witness.json").write_text('{"processes":[{"pid":42,"ppid":7}]}')
print("fixture failure", file=sys.stderr)
sys.exit(17)
''')
    output = tmp_path / 'artifacts'
    output.mkdir()
    (output / 'native-pm-lifecycle.json').write_text('{"status":"passed"}')
    with pytest.raises(subprocess.CalledProcessError) as error:
        runner.run_lifecycle([sys.executable, str(fixture)], output=output, cwd=tmp_path, env={})
    assert error.value.returncode == 17
    assert (output / 'native-pm-gateway.log').read_text() == 'gateway failed'
    assert (output / 'native-pm-runtime-receipt.json').read_text() == '{"state":"paused"}'
    assert (output / 'native-pm-startup-witness.json').read_text() == '{"processes":[{"pid":42,"ppid":7}]}'
    assert 'fixture failure' in (output / 'native-pm-lifecycle.log').read_text()
    assert not (output / 'native-pm-lifecycle.json').exists()
