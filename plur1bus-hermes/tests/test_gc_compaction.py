import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class _Search:
    def __init__(self, rows):
        self.rows = rows

    def where(self, _predicate):
        return self

    def limit(self, _limit):
        return self

    def to_list(self):
        return list(self.rows)


class _Table:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def search(self):
        return _Search(self.rows)

    def update(self, where, values):
        self.updates.append((where, values))


class GcCompactionTests(unittest.TestCase):
    def test_gc_archives_expired_card_before_status_update(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            memory_id = "53628ada-8595-43dc-92da-216fe2c69836"
            domain._metadata_rows = lambda: [
                {
                    "id": memory_id,
                    "metadataJson": '{"expiresAt":100}',
                }
            ]
            table = _Table(
                [{"id": memory_id, "content": "expired", "status": "active"}]
            )

            result = domain.run_gc(table, now_ms=200)

            self.assertEqual(result["count"], 1)
            self.assertEqual(result["hardDeleted"], 0)
            self.assertTrue(
                (
                    Path(temporary)
                    / f"archives/main/gc/{memory_id}.json"
                ).is_file()
            )
            self.assertEqual(table.updates[0][1], {"status": "archived"})


if __name__ == "__main__":
    unittest.main()
