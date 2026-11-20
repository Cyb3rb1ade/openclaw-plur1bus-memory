"""One Torch lock per process, shared by every profile's copy of this plugin.

Hermes imports a directory plugin once per profile home (``hermes_plugins.plur1bus`` for the first home,
``hermes_plugins.plur1bus__home_<digest>`` for every other one), so a module-level lock exists once per
profile and does not keep two profiles apart.  PyTorch on Metal (MPS) aborts the whole process
("failed assertion _status < MTLCommandBufferStatusCommitted ... setCurrentCommandEncoder") when two threads
load weights onto the device or run a model on it at the same time, which ends the Hermes gateway with no
exit path.  The lock therefore lives in ``sys.modules`` under a fixed name that every copy finds, and it
covers model construction as well as inference.  Re-entrant: a load that runs a warm-up encode keeps it.
"""
from __future__ import annotations

import sys
import threading
import types

_HOLDER_NAME = "_plur1bus_process_locks"


def _holder() -> types.ModuleType:
    holder = sys.modules.get(_HOLDER_NAME)
    if holder is None:
        holder = sys.modules.setdefault(_HOLDER_NAME, types.ModuleType(_HOLDER_NAME))
    return holder


# dict.setdefault is atomic, so two copies importing at once still end up with the same lock
TORCH_LOCK = _holder().__dict__.setdefault("torch", threading.RLock())
