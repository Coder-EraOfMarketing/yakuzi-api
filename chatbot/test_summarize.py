from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from main import app, html_to_text

client = TestClient(app)

POST_HTML = (
    "<h2>Why fans collect</h2>"
    "<p>Collectors in India buy figures for display, not for resale.</p>"
    "<p>Prices start around &#8377;250 for manga and rise past &#8377;10,000 "
    "for 1:1 replicas.</p>"
)


def _gemini_returning(text):
    response = MagicMock()
    response.text = text
    genai = MagicMock()
    genai.models.generate_content.return_value = response
    return genai


def _post(body, genai=None):
    """Call /summarize with Gemini configured and (optionally) stubbed."""
    patches = [
        patch("main.HAS_GEMINI", True),
        patch.dict("os.environ", {"GEMINI_API_KEY": "test-key"}),
    ]
    if genai is not None:
        patches.append(patch("main.get_genai_client", return_value=genai))
    for p in patches:
        p.start()
    try:
        return client.post("/summarize", json=body)
    finally:
        for p in reversed(patches):
            p.stop()


def test_summarize_returns_the_models_summary():
    genai = _gemini_returning("Indian collectors buy figures to display them.")
    res = _post({"title": "Collecting in India", "content": POST_HTML}, genai)
    assert res.status_code == 200
    assert res.json()["summary"] == "Indian collectors buy figures to display them."


def test_summarize_sends_the_visible_text_not_the_markup():
    """The editor stores HTML. Sending tags wastes the context window and puts
    markup in front of the model instead of the article."""
    genai = _gemini_returning("A summary.")
    _post({"title": "Collecting in India", "content": POST_HTML}, genai)
    prompt = genai.models.generate_content.call_args.kwargs["contents"]
    assert "Collectors in India buy figures" in prompt
    assert "<p>" not in prompt and "<h2>" not in prompt
    # Entities become the characters a reader sees, not their escape codes.
    assert "₹250" in prompt
    assert "&#8377;" not in prompt
    # The title is context the body often does not repeat.
    assert "Collecting in India" in prompt


def test_summarize_asks_for_a_bounded_factual_summary():
    genai = _gemini_returning("A summary.")
    _post({"title": "T", "content": POST_HTML, "max_words": 45}, genai)
    prompt = genai.models.generate_content.call_args.kwargs["contents"]
    assert "45 words" in prompt


def test_summarize_caps_a_runaway_word_limit():
    genai = _gemini_returning("A summary.")
    _post({"title": "T", "content": POST_HTML, "max_words": 9000}, genai)
    prompt = genai.models.generate_content.call_args.kwargs["contents"]
    assert "9000 words" not in prompt


def test_summarize_truncates_a_very_long_article():
    """A 200k-character post would be rejected by the API or billed in full;
    the opening of an article is what a summary needs anyway."""
    genai = _gemini_returning("A summary.")
    _post({"title": "T", "content": "<p>word word word.</p>" * 20000}, genai)
    prompt = genai.models.generate_content.call_args.kwargs["contents"]
    assert len(prompt) < 20000


def test_summarize_strips_markdown_and_quotes_the_model_adds():
    """aiSummary is published as plain text — asterisks and a wrapping quote
    would be rendered literally on the page and in llms.txt."""
    genai = _gemini_returning('"**Summary:** Collectors buy figures to display."')
    res = _post({"title": "T", "content": POST_HTML}, genai)
    summary = res.json()["summary"]
    assert summary == "Collectors buy figures to display."


def test_summarize_rejects_content_too_thin_to_summarise():
    res = _post({"title": "T", "content": "<p>Hi.</p>"}, _gemini_returning("x"))
    assert res.status_code == 400


def test_summarize_fails_cleanly_when_gemini_is_unavailable():
    with patch("main.HAS_GEMINI", False):
        res = client.post("/summarize", json={"title": "T", "content": POST_HTML})
    assert res.status_code == 500


def test_summarize_fails_cleanly_when_the_model_returns_nothing():
    res = _post({"title": "T", "content": POST_HTML}, _gemini_returning("   "))
    assert res.status_code == 500


def test_html_to_text_keeps_block_boundaries():
    """Without them, "…display.Prices start…" reads as one sentence and the
    model summarises a run-on."""
    text = html_to_text("<p>One.</p><p>Two.</p><ul><li>Three</li></ul>")
    assert "One." in text and "Two." in text
    assert "One.Two." not in text


def test_html_to_text_drops_script_and_style_bodies():
    text = html_to_text("<style>p{color:red}</style><p>Real text.</p>")
    assert "Real text." in text
    assert "color:red" not in text
