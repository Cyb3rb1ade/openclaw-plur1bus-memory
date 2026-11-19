import lancedb

from plur1bus_hermes.domain import Plur1busDomain


def test_critical_review_sees_a_card_committed_by_another_connection(tmp_path):
    domain = Plur1busDomain(tmp_path, "main")
    binding = domain._scope_selector()
    route = tmp_path / "lancedb" / "main"
    first = {
        "id": "53628ada-8595-43dc-92da-216fe2c69836",
        "agentId": "main",
        "scopeKey": binding.scope_key,
        "aclBindings": binding.acl_bindings,
        "status": "active",
        "confirmed": False,
        "createdAt": "2026-11-17T12:00:00Z",
        "type": "person",
    }
    lancedb.connect(str(route)).create_table("memories", data=[first])
    assert [card["id"] for card in domain.critical_review_page()["items"]] == [first["id"]]

    second = {**first, "id": "a4563cc9-7611-4528-992a-075f8889a018"}
    writer = lancedb.connect(str(route)).open_table("memories")
    writer.add([second])

    assert {card["id"] for card in domain.critical_review_page()["items"]} == {
        first["id"], second["id"],
    }
