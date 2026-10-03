"""Directory packages must survive Hermes dependency generation replacement."""
from pathlib import Path
import importlib.util
import tomllib

PATH = Path(__file__).resolve().parents[1] / "build.py"
SPEC = importlib.util.spec_from_file_location("plur1bus_distribution_build", PATH)
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def test_directory_project_installs_canonical_package():
    for package, module in (("plur1bus-hermes", "plur1bus_hermes"),
                            ("plur1bus-controls", "plur1bus_controls")):
        data = tomllib.loads(BUILD.directory_project(package, module).decode())
        assert data["project"]["name"] == package
        assert data["project"]["version"] == "7.18.4"
        assert data["tool"]["setuptools"]["packages"] == [module]
        assert data["tool"]["setuptools"]["package-dir"] == {module: "."}
        assert "readme" not in data["project"]


def test_current_python_uses_native_onnx_dependency_declaration():
    data = tomllib.loads(BUILD.directory_project("plur1bus-hermes", "plur1bus_hermes").decode())
    dependencies = data["project"]["dependencies"]
    assert "numpy==2.4.3; python_version >= '3.14'" in dependencies
    assert "onnxruntime>=1.20,<2; python_version >= '3.14'" in dependencies
