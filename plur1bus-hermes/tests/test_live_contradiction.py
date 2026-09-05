import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class _Search:
    def where(self, _predicate):
        return self

    def limit(self, _limit):
        return self

    def to_list(self):
        return [
            {
                "id": "existing",
                "content": "Bernd will morgen nicht nach Berlin fahren",
                "_distance": 0.2,
            }
        ]


class _Table:
    def search(self, _vector):
        return _Search()


class LiveContradictionTests(unittest.TestCase):
    def test_capture_neighbor_creates_contradiction_edge_and_disclosure(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")

            domain._build_graph_edges(
                {
                    "id": "new",
                    "content": "Bernd will morgen nach Berlin fahren",
                    "vector": [0.1, 0.2],
                },
                _Table(),
            )

            edges = domain._read_jsonl(domain.neo_dir / "memory-graph.jsonl")
            disclosure = domain._read_jsonl(
                domain.neo_dir / "contradiction-disclosure.jsonl"
            )
            self.assertTrue(any(edge["type"] == "contradiction" for edge in edges))
            self.assertEqual(disclosure[0]["status"], "requires_review")


if __name__ == "__main__":
    unittest.main()
