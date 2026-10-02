"""TEST ONLY: a Python contender for the shared bindings-registry lock (tests/dist-hermes-lock-interop.test.js).

Uses the harness ExclusiveLockFile (tests/fixtures/hermes/python/_filelock.py, a byte copy of
hosts/hermes/plur1bus/_filelock.py) exactly as binding.py register_binding does. Per hold it appends to
<home>/events.log: E (entered), then after ``held.verify()`` either L (lock lost: nothing written) or W (the guarded
read-modify-write of <home>/counter ran), then X (left). Every ``die_every``-th hold it logs D after the verify and
kills itself while still holding the lock (SIGKILL; TerminateProcess on Windows), as a killed installer would.

Usage: python lock-interop-worker.py <fixture python dir> <plur1bus home> <id> <die_every> <until_epoch_ms>
"""

import os
import signal
import sys
import time

sys.dont_write_bytecode = True  # no __pycache__ beside the byte-copied fixture
sys.path.insert(0, sys.argv[1])
from _filelock import ExclusiveLockFile, LockLost, LockTimeout  # noqa: E402

home, wid, die_every, until = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
lock = ExclusiveLockFile(os.path.join(home, "hosts", ".hermes-bindings.lock"))
events = os.path.join(home, "events.log")
counter = os.path.join(home, "counter")


def log(kind, seq):
    fd = os.open(events, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, f"{kind} {wid} {seq}\n".encode())
    finally:
        os.close(fd)


def die():
    os.kill(os.getpid(), signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
    time.sleep(10)


seq = 0
while time.time() * 1000 < until:
    try:
        with lock.hold(timeout=10.0) as held:
            seq += 1
            log("E", seq)
            time.sleep(0.002)
            try:
                held.verify()
            except LockLost:
                log("L", seq)
                log("X", seq)
                continue
            if seq % die_every == 0:
                log("D", seq)
                die()
            with open(counter, "r+" if os.path.exists(counter) else "w+") as f:
                n = int(f.read() or "0")
                f.seek(0)
                f.truncate()
                f.write(str(n + 1))
            log("W", seq)
            log("X", seq)
    except LockTimeout:
        pass
