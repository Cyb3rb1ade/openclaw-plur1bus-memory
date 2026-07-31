import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class _IndexTable:
    def __init__(self):
        self.calls = []

    def create_index(self, **kwargs):
        self.calls.append(kwargs)


class DomainIndexTests(unittest.TestCase):
    def test_rebuild_indexes_materializes_graph_and_ann_indexes(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain.neo_dir.mkdir(parents=True, exist_ok=True)
            graph_path = domain.neo_dir / "memory-graph.jsonl"
            graph_path.write_text(
                "\n".join(
                    [
                        json.dumps({"source": "a", "target": "b", "type": "semantic"}),
                        json.dumps({"source": "b", "target": "c", "type": "entity"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            table = _IndexTable()

            result = domain.rebuild_indexes(table)

            self.assertEqual(result["graphEdges"], 2)
            self.assertEqual(result["communities"], 1)
            self.assertEqual(result["annIndex"], "created")
            self.assertEqual(
                table.calls,
                [{"metric": "cosine", "vector_column_name": "vector", "replace": True}],
            )
            semantic = domain.workspace_dir / ".plur1bus" / "semantic-lens-index.json"
            links = domain.workspace_dir / ".plur1bus" / "link-index.json"
            self.assertTrue(semantic.is_file())
            self.assertTrue(links.is_file())
            entries = json.loads(links.read_text(encoding="utf-8"))["entries"]
            self.assertEqual(entries["a"]["links"], ["b"])

    def test_obsidian_candidates_are_hash_tracked(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            note = domain.workspace_dir / "Memory" / "card.md"
            note.parent.mkdir(parents=True, exist_ok=True)
            note.write_text("# First\n", encoding="utf-8")

            candidates = domain.obsidian_candidates()
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["path"], "Memory/card.md")

            domain.mark_obsidian_synced(candidates)
            self.assertEqual(domain.obsidian_candidates(), [])

            note.write_text("# Changed\n", encoding="utf-8")
            changed = domain.obsidian_candidates()
            self.assertEqual(len(changed), 1)
            self.assertEqual(changed[0]["path"], "Memory/card.md")


if __name__ == "__main__":
    unittest.main()
