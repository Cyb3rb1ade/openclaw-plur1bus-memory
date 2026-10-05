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
        assert data["project"]["version"] == "7.18.20"
        assert data["tool"]["setuptools"]["packages"] == [module]
        assert data["tool"]["setuptools"]["package-dir"] == {module: "."}
        assert "readme" not in data["project"]


def test_current_python_uses_native_onnx_dependency_declaration():
    data = tomllib.loads(BUILD.directory_project("plur1bus-hermes", "plur1bus_hermes").decode())
    dependencies = data["project"]["dependencies"]
    assert "numpy==2.4.3; python_version >= '3.14'" in dependencies
    assert "onnxruntime>=1.20,<2; python_version >= '3.14'" in dependencies


def test_pm_arm_sources_are_exactly_marker_scoped_and_local():
    data = tomllib.loads(BUILD.directory_project("plur1bus-hermes", "plur1bus_hermes", pm_arm_sources=True).decode())
    marker = "sys_platform == 'win32' and platform_machine == 'ARM64' and python_version >= '3.14' and python_version < '3.15'"
    assert data["tool"]["uv"]["sources"] == {
        "lancedb": {"path": "vendor/windows-arm64/lancedb-0.34.0-cp39-abi3-win_arm64.whl", "marker": marker},
        "pyarrow": {"path": "vendor/windows-arm64/pyarrow-25.0.1-cp314-cp314-win_arm64.whl", "marker": marker},
    }
    assert any(dep == "pyarrow==25.0.1; " + marker for dep in data["project"]["dependencies"])


def test_default_project_has_no_platform_local_uv_sources_or_pyarrow_pin():
    data = tomllib.loads(BUILD.directory_project("plur1bus-hermes", "plur1bus_hermes").decode())
    assert "tool" not in data or "uv" not in data["tool"]
    assert not any(dependency.startswith("pyarrow==25.0.1;") for dependency in data["project"]["dependencies"])


def test_cp314_arm_keeps_pypi_tokenizer_abi3_and_onnx_runtime_dependencies():
    from packaging.tags import cpython_tags

    data = tomllib.loads(BUILD.directory_project("plur1bus-hermes", "plur1bus_hermes", pm_arm_sources=True).decode())
    dependencies = data["project"]["dependencies"]
    assert "tokenizers>=0.21,<1; python_version >= '3.14'" in dependencies
    assert "onnxruntime>=1.20,<2; python_version >= '3.14'" in dependencies
    assert "tokenizers" not in data["tool"]["uv"]["sources"]
    cp314_arm_tags = {str(tag) for tag in cpython_tags((3, 14), abis=["cp314"], platforms=["win_arm64"])}
    assert "cp310-abi3-win_arm64" in cp314_arm_tags
