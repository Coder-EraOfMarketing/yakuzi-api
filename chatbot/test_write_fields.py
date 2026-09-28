from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from main import app, split_keywords, clip_to

client = TestClient(app)

POST_HTML = (
    "<h2>Why fans collect</h2>"
    "<p>Collectors in India buy anime figures for display, not for resale. "
    "Prices start around &#8377;250 for manga and rise past &#8377;10,000 "
    "for 1:1 replicas, and authenticity is the main risk.</p>"
)


def _gemini_returning(text):
    response = MagicMock()
    response.text = text
    genai = MagicMock()
    genai.models.generate_content.return_value = response
    return genai


def _post(body, genai):
    with patch("main.HAS_GEMINI", True), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "test-key"}), \
         patch("main.get_genai_client", return_value=genai):
        return client.post("/summarize", json={"content": POST_HTML, **body})


def _prompt(genai):
    return genai.models.generate_content.call_args.kwargs["contents"]


def test_kind_defaults_to_the_summary_it_always_was():
    """The deployed admin sends no `kind`. It must keep getting a summary."""
    genai = _gemini_returning("Indian collectors buy figures to display them.")
    res = _post({"title": "T"}, genai)
    assert res.status_code == 200
    assert res.json()["text"] == "Indian collectors buy figures to display them."
    # The old field name is still served, so an admin deployed before this
    # change keeps working through the rollout.
    assert res.json()["summary"] == res.json()["text"]


def test_meta_description_is_asked_for_and_capped_at_160():
    genai = _gemini_returning("x" * 400)
    res = _post({"title": "T", "kind": "meta_description"}, genai)
    assert "meta description" in _prompt(genai).lower()
    text = res.json()["text"]
    assert len(text) <= 160


def test_meta_description_is_cut_on_a_word_boundary():
    original = (
        "Indian collectors buy anime figures to display them rather than to resell, "
        "with prices running from about two hundred and fifty rupees for manga "
        "volumes up to well past ten thousand for replicas."
    )
    text = _post({"kind": "meta_description"}, _gemini_returning(original)).json()["text"]
    assert len(text) <= 160
    assert text != original  # it really was too long
    assert not text.endswith(" ")
    # A description chopped mid-word reads as broken in a search result, so
    # every word kept must be a whole word from the original.
    assert text.split()[-1] in original.split()


def test_excerpt_allows_more_room_than_a_meta_description():
    genai = _gemini_returning("y" * 600)
    text = _post({"kind": "excerpt"}, genai).json()["text"]
    assert 160 < len(text) <= 300


def test_keywords_come_back_as_a_list_not_a_sentence():
    genai = _gemini_returning("anime figures india, funko pop, collectible statues")
    body = _post({"kind": "keywords"}, genai).json()
    assert body["keywords"] == [
        "anime figures india",
        "funko pop",
        "collectible statues",
    ]


def test_keywords_survive_a_bulleted_reply():
    """Models answer list questions with lists however hard you ask them not to."""
    genai = _gemini_returning("- Anime Figures\n- Funko Pop\n* anime figures\n")
    body = _post({"kind": "keywords"}, genai).json()
    # Lowercased and de-duplicated: "Anime Figures" and "anime figures" are one
    # keyword, and a duplicate in the meta tag says nothing twice.
    assert body["keywords"] == ["anime figures", "funko pop"]


def test_keywords_are_capped():
    genai = _gemini_returning(", ".join(f"kw{i}" for i in range(40)))
    assert len(_post({"kind": "keywords"}, genai).json()["keywords"]) <= 12


def test_an_unknown_kind_is_rejected_rather_than_guessed():
    genai = _gemini_returning("whatever")
    assert _post({"kind": "haiku"}, genai).status_code == 422


def test_every_kind_still_refuses_an_empty_post():
    genai = _gemini_returning("text")
    for kind in ("summary", "meta_description", "excerpt", "keywords"):
        with patch("main.HAS_GEMINI", True), \
             patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
             patch("main.get_genai_client", return_value=genai):
            res = client.post("/summarize", json={"content": "<p>Hi.</p>", "kind": kind})
        assert res.status_code == 400, kind


def test_each_kind_asks_for_something_different():
    seen = set()
    for kind in ("summary", "meta_description", "excerpt", "keywords"):
        genai = _gemini_returning("text")
        _post({"kind": kind}, genai)
        seen.add(_prompt(genai))
    assert len(seen) == 4


def test_clip_to_keeps_whole_words():
    assert clip_to("one two three four", 9) == "one two"
    assert clip_to("short", 100) == "short"
    # A single word longer than the limit still has to be cut somewhere.
    assert len(clip_to("a" * 50, 10)) <= 10


def test_split_keywords_handles_the_shapes_models_return():
    assert split_keywords("a, b; c") == ["a", "b", "c"]
    assert split_keywords("1. first\n2. second") == ["first", "second"]
    assert split_keywords("") == []
