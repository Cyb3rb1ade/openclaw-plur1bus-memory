"""Directory loading must not split provider/Controls process-local registries."""
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

import plur1bus_hermes
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.service import PLUR1BUS_SERVICE


def load_directory():
    path = Path(plur1bus_hermes.__file__)
    spec = importlib.util.spec_from_file_location("hermes_test_plur1bus_directory", path,
                                                submodule_search_locations=[str(path.parent)])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_directory_provider_uses_canonical_runtime_identity():
    directory = load_directory()
    assert directory.Plur1busMemoryProvider is Plur1busMemoryProvider
    assert sys.modules[directory.Plur1busMemoryProvider.__module__].PLUR1BUS_SERVICE is PLUR1BUS_SERVICE
    assert "hermes_test_plur1bus_directory.provider" not in sys.modules


def test_directory_provider_rejects_stale_installed_package():
    with patch.object(plur1bus_hermes, "__version__", "0.0.0"):
        try:
            load_directory()
        except RuntimeError as error:
            assert "versions differ" in str(error)
        else:
            raise AssertionError("stale runtime package accepted")
