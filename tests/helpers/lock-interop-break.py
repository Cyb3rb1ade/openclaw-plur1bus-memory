"""TEST ONLY: drive the harness ExclusiveLockFile's stale break step by step (tests/dist-hermes-lock-interop.test.js).

The T8 double-break race, made deterministic: judge the lock stale (``_judge_stale``), write <dir>/judged, wait for
<dir>/go (meanwhile the Node side breaks the same stale lock and creates its own live lock), then run ``_break`` with
the stale judgement. A correct break sees another inode and content, puts the live lock back and returns False; a
break without that check removes the live Node lock. Prints ``{"judged": bool, "broke": bool}``.

Usage: python -B lock-interop-break.py <fixture python dir> <lock path> <signal dir>
"""

import json
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from _filelock import ExclusiveLockFile  # noqa: E402

lock, sig = sys.argv[2], sys.argv[3]
lk = ExclusiveLockFile(lock)
judged = lk._judge_stale()
with open(os.path.join(sig, "judged"), "w") as f:
    f.write("1" if judged else "0")
deadline = time.monotonic() + 20
while not os.path.exists(os.path.join(sig, "go")) and time.monotonic() < deadline:
    time.sleep(0.005)
broke = bool(judged) and lk._break(*judged)
print(json.dumps({"judged": judged is not None, "broke": broke}))
