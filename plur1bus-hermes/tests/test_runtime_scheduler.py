import threading
import unittest

from plur1bus_hermes.runtime_scheduler import AdmissionRejected, BoundedExecutor


class BoundedExecutorTests(unittest.TestCase):
    def test_full_queue_rejects_without_running_and_releases_capacity(self):
        executor = BoundedExecutor(max_queue=1)
        started, finish = threading.Event(), threading.Event()
        def hold():
            started.set()
            finish.wait(2)
        try:
            first = executor.submit(hold)
            self.assertTrue(started.wait(1))
            second = executor.submit(lambda: 2)
            with self.assertRaises(AdmissionRejected):
                executor.submit(lambda: self.fail("rejected task ran"))
            finish.set()
            first.result(2)
            self.assertEqual(second.result(2), 2)
            self.assertEqual(executor.submit(lambda: 3).result(2), 3)
        finally:
            finish.set()
            executor.shutdown()
        self.assertEqual(executor.metrics["pending"], 0)

    def test_expired_queued_work_does_not_execute(self):
        now = [0.0]
        executor = BoundedExecutor(max_queue=1, clock=lambda: now[0])
        started, finish = threading.Event(), threading.Event()
        def hold():
            started.set()
            finish.wait(2)
        try:
            first = executor.submit(hold)
            self.assertTrue(started.wait(1))
            second = executor.submit(lambda: self.fail("expired task ran"))
            now[0] = 61
            finish.set()
            first.result(2)
            with self.assertRaises(AdmissionRejected):
                second.result(2)
        finally:
            finish.set()
            executor.shutdown()
        self.assertEqual(executor.metrics["expired"], 1)

    def test_failure_cancellation_and_shutdown_release_slots(self):
        executor = BoundedExecutor(max_queue=1)
        failed = executor.submit(lambda: 1 / 0)
        with self.assertRaises(ZeroDivisionError):
            failed.result(1)
        executor.shutdown()
        self.assertEqual(executor.metrics["pending"], 0)
        with self.assertRaises(AdmissionRejected):
            executor.submit(lambda: None)
