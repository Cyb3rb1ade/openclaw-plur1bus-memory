from plur1bus_hermes.recall_quality import apply_stale_assistant_weighting


def test_old_uninformative_assistant_yields_to_user_and_keeps_records_unchanged():
    now = 200 * 86_400_000
    rows = [
        {"id": "a", "sourceRole": "assistant", "content": "Alles klar!", "createdAt": 86_400_000, "rerankScore": -1.0},
        {"id": "b", "sourceRole": "user", "content": "A task decision", "createdAt": 86_400_000, "rerankScore": -1.2},
    ]
    assert [row["id"] for row in apply_stale_assistant_weighting(rows, now, {})] == ["b", "a"]
    assert rows[0]["rerankScore"] == -1.0
    assert apply_stale_assistant_weighting(rows, now, {"staleAssistant": False}) is rows


def test_informative_recent_reply_retains_reranker_order():
    now = 200 * 86_400_000
    rows = [
        {"id": "a", "sourceRole": "assistant", "content": "Decision ID 248: " + "record detail " * 20,
         "createdAt": now - 20 * 86_400_000, "rerankScore": 0.91},
        {"id": "b", "sourceRole": "user", "content": "A recent question", "createdAt": now, "rerankScore": 0.90},
    ]
    assert apply_stale_assistant_weighting(rows, now, {}) is rows
