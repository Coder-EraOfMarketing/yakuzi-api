import os
import re
import sys
import time
import traceback
from contextvars import ContextVar
from html import unescape as html_unescape
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import base64
import json
import uvicorn
from dotenv import load_dotenv

# Load environment variables
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

try:
    import psycopg2  # type: ignore
    from psycopg2.extras import RealDictCursor  # type: ignore
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False

try:
    from google import genai
    from google.genai import types
    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

app = FastAPI(title="Yukizi AI Chatbot Sidecar")

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    print(f"Validation Error: {exc}", file=sys.stderr)
    print(f"Body: {await request.body()}", file=sys.stderr)
    return JSONResponse(status_code=422, content={"detail": exc.errors()})

# ==========================================
# STATE MANAGEMENT (Prompt & Active Model)
# ==========================================
# Anchor state files to this file's directory. They used to be resolved against the
# process CWD, so launching the sidecar from anywhere other than chatbot/ silently
# created a second, empty set of state files instead of reading the real ones.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_FILE = os.path.join(BASE_DIR, "current_model.txt")

DEFAULT_PROMPT = """You are an intelligent, versatile AI Assistant integrated into the Yukizi platform powered by Gemini Thinking.

CORE PRIORITIES:
- Store & Order Inquiries: For store-related inquiries, assist customers with products, order status, and shopping using your integrated database tools (search_products, get_order_status, search_blogs, get_product_reviews) and learned training data. When a customer asks whether a product is good, worth buying, or how others liked it, use get_product_reviews to answer from real customer feedback instead of guessing.
- General AI Knowledge: You are NOT restricted to store topics. If a user asks general knowledge, scientific, technical, coding, or any off-topic question, seamlessly utilize your full general AI knowledge and reasoning to provide a helpful, accurate, and comprehensive answer, exactly as a standard Gemini assistant would.

FORMATTING & STYLING RULES:
- Do NOT output raw Markdown asterisks (like * or **) in your responses.
- Use clean Unicode bullet dots (•) for list items and place every bullet point on its own new line.
- Use clear spacing between paragraphs for readability.
- Write in warm, professional, human-friendly, and beautifully formatted natural language.
"""

def load_text_file(filename: str, default_val: str) -> str:
    if os.path.exists(filename):
        with open(filename, 'r', encoding='utf-8') as f:
            return f.read().strip()
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(default_val)
    return default_val

# Initialize state
ACTIVE_MODEL = load_text_file(MODEL_FILE, "gemini-2.5-flash")

# ==========================================
# MODELS
# ==========================================
class Attachment(BaseModel):
    name: str
    data: str
    type: str

class ChatMessage(BaseModel):
    role: str
    content: Optional[str] = ""
    attachments: Optional[List[Attachment]] = []

class ChatRequest(BaseModel):
    message: Optional[str] = ""
    history: Optional[List[ChatMessage]] = []
    attachments: Optional[List[Attachment]] = []
    thinking_enabled: Optional[bool] = True
    thinking_budget: Optional[int] = 2048
    # Compiled by the Chatbot Studio in the API. When present it replaces
    # everything build_system_instruction() would have assembled here, so the
    # persona, the boundaries and the taught rules all come from one place.
    # Absent (an older caller, or a direct curl) keeps the previous behaviour.
    system_instruction: Optional[str] = None
    # Exactly the tools the admin left switched on. None means "all of them",
    # which is what every caller before the Studio expected.
    tools: Optional[List[str]] = None
    # Where the customer is on the storefront right now (path and title), so
    # "is this good?" on a product page needs no clarifying question.
    page_context: Optional[str] = None

class ConversationTrainRequest(BaseModel):
    history: List[ChatMessage]
    custom_name: Optional[str] = "yukizi-custom-bot"


class SummarizeRequest(BaseModel):
    """A blog post the admin wants an AI-search summary for.

    `content` is the rich-text editor's HTML, exactly as it is stored — the
    caller should not have to strip it, and stripping it in one place keeps
    the text the model sees identical to the text a reader sees.
    """
    title: Optional[str] = ""
    content: str
    max_words: Optional[int] = 60


# ==========================================
# GEMINI CLIENT
# ==========================================
_GENAI_CLIENT = None
_GENAI_CLIENT_KEY = None

def get_genai_client(api_key: str):
    """Build the Gemini client once and reuse it.

    It used to be constructed on every /chat request, which re-read the TLS trust
    store from disk each time -- so anything that disturbed the sidecar's virtualenv
    turned every single message into an error.
    """
    global _GENAI_CLIENT, _GENAI_CLIENT_KEY
    if _GENAI_CLIENT is None or _GENAI_CLIENT_KEY != api_key:
        _GENAI_CLIENT = genai.Client(api_key=api_key)
        _GENAI_CLIENT_KEY = api_key
    return _GENAI_CLIENT

# ==========================================
# DATABASE TOOLS (Level 2)
# ==========================================
def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url or not HAS_PSYCOPG2:
        return None
    try:
        return psycopg2.connect(db_url)
    except Exception as e:
        print(f"Database connection error: {e}", file=sys.stderr)
        return None

# Retail filler the model tacks onto a series name. Left in, they turn the
# search into a phrase nothing can match: a customer asking "which naruto toy
# should i buy" produced ILIKE '%naruto toy%', which finds nothing, and the
# assistant answered "I couldn't find any Naruto toys in the store" while a
# Naruto figure sat on the page behind it.
SEARCH_STOPWORDS = {
    'a', 'an', 'and', 'any', 'are', 'best', 'buy', 'can', 'cheap', 'collectible',
    'collectibles', 'do', 'figure', 'figures', 'figurine', 'figurines', 'find',
    'for', 'from', 'good', 'have', 'in', 'is', 'item', 'items', 'me', 'merch',
    'merchandise', 'model', 'my', 'of', 'on', 'or', 'product', 'products',
    'recommend', 'should', 'show', 'some', 'statue', 'statues', 'stock', 'store',
    'suggest', 'the', 'to', 'toy', 'toys', 'want', 'what', 'which', 'with', 'you',
    # Budget phrasing. These belong in max_price/min_price, never in the text
    # match — "naruto under 2000" must search for naruto, not for "under".
    'above', 'around', 'below', 'between', 'budget', 'cheaper', 'cost', 'costs',
    'inr', 'less', 'over', 'price', 'priced', 'prices', 'rs', 'rupee', 'rupees',
    'than', 'under', 'within',
}


def _specific_tokens(query: str) -> list:
    """Words that actually identify a product: not stopwords, and not the bare
    numbers a customer uses as a budget ("under 2000")."""
    words = re.findall(r"[a-z0-9]+", (query or '').lower())
    return [w for w in words if len(w) > 1 and w not in SEARCH_STOPWORDS and not w.isdigit()]


def search_tokens(query: str) -> list:
    """The meaningful words in a search phrase, most specific first.

    ILIKE '%<whole phrase>%' only ever matches a contiguous substring, so any
    query with more than one word was effectively a guess that the catalogue
    spelled things exactly the way the customer did. Splitting lets "naruto toy"
    match a product called "Naruto Uzumaki Chibi".

    Falls back to the raw words, then to the whole string, so a search made
    entirely of stopwords still asks the database something.
    """
    words = re.findall(r"[a-z0-9]+", (query or '').lower())
    kept = _specific_tokens(query)
    return (kept or words or [(query or '').strip().lower()])[:6]


# Budget phrases the tool parses out of the query itself. The schema-level
# max_price/min_price parameters are the clean path, but the interpreter the
# production sidecar runs on is only guaranteed to deliver `query` — old
# google-genai releases drop Optional parameters from the declaration — so a
# budget must also survive the trip inside the text.
_PRICE_NUM = r'(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)'
_MAX_WORDS = r'(?:under|below|within|upto|up\s+to|max(?:imum)?(?:\s+of)?|less\s+than|cheaper\s+than|budget(?:\s+(?:of|is))?)'
_MIN_WORDS = r'(?:above|over|at\s+least|more\s+than|min(?:imum)?(?:\s+of)?|starting(?:\s+(?:from|at))?)'


def parse_budget(query: str):
    """(max_price, min_price) stated in the text, or (None, None).

    A bare number is never treated as a budget — "one piece 2022" is a
    product search, not a price cap. Only a budget word makes it one.
    """
    q = (query or '').lower()
    def num(s): return float(s.replace(',', ''))
    between = re.search(r'between\s+' + _PRICE_NUM + r'\s+and\s+' + _PRICE_NUM, q)
    if between:
        a, b = num(between.group(1)), num(between.group(2))
        return (max(a, b), min(a, b))
    mx = re.search(_MAX_WORDS + r'\s+' + _PRICE_NUM, q)
    mn = re.search(_MIN_WORDS + r'\s+' + _PRICE_NUM, q)
    return (num(mx.group(1)) if mx else None, num(mn.group(1)) if mn else None)


# Structured copies of what the product tools returned during the current
# /chat request. The storefront widget renders these as tappable product
# cards — image, price, working link — instead of leaving the customer with
# re-typed text. A ContextVar so concurrent requests never share a bucket;
# tools run synchronously inside the request's own context.
_collected_products: ContextVar = ContextVar('collected_products', default=None)


def _record_products(rows):
    bucket = _collected_products.get()
    if bucket is None:
        return
    for row in rows:
        url = row.get('url')
        if not url or any(p.get('url') == url for p in bucket):
            continue
        if len(bucket) >= 10:
            return
        bucket.append({
            'name': row.get('name'),
            'price': row.get('price'),
            'stock': row.get('stock'),
            'url': url,
            'image': row.get('image'),
            'category': row.get('category'),
            'avg_rating': row.get('avg_rating'),
        })


def _normalize_product_rows(rows):
    """Shared post-processing for every tool that returns catalogue rows.

    RealDictCursor returns Decimal for numeric columns; str(Decimal(...))
    renders as Python constructor syntax (e.g. "Decimal('499.00')"), which
    Gemini could echo verbatim into a customer-facing reply, so cast to plain
    floats before stringifying. A None price survives as None: no live offer
    means there is no price to quote, and the model should say so, not invent
    one. The slug becomes a finished /products/<slug> path — a guessed URL is
    a broken link in front of a customer.
    """
    for row in rows:
        row['price'] = float(row['price']) if row.get('price') is not None else None
        row['avg_rating'] = float(row['avg_rating']) if row.get('avg_rating') is not None else None
        row['url'] = f"/products/{row['slug']}" if row.get('slug') else None
        row.pop('match_score', None)
        row.pop('slug', None)
    _record_products(rows)
    return rows


# The catalogue columns every product tool selects, kept in one place so the
# storefront price rule (cheapest live approved offer, finalCustomerPayable
# falling back to that offer's MRP — products.service.ts) cannot drift
# between tools. cp.mrp is nullable and unset for seller-priced products;
# reading it is what once had the assistant telling customers it could not
# see prices. Only approved offers count, or the bot could quote a price no
# customer can actually pay.
_PRODUCT_COLUMNS_SQL = (
    'cp.name, cp.slug, cp.manufacturer, cp.description, '
    'c.name AS category, '
    '('
    '  SELECT ci.url FROM catalog_product_images ci '
    '  WHERE ci."masterProductId" = cp.id '
    '  ORDER BY ci."order" ASC, ci.id ASC LIMIT 1'
    ') AS image, '
    '('
    '  SELECT COALESCE(so."finalCustomerPayable", so.mrp) '
    '  FROM seller_offers so '
    '  WHERE so."catalogProductId" = cp.id AND so."isActive" = true '
    '  AND so."deletedAt" IS NULL '
    '  AND so."approvalStatus" = \'APPROVED\' '
    '  ORDER BY so.mrp ASC LIMIT 1'
    ') AS price, '
    'COALESCE(('
    '  SELECT SUM(pb.stock) FROM product_batches pb '
    '  JOIN seller_offers so ON so.id = pb."sellerOfferId" '
    '  WHERE so."catalogProductId" = cp.id AND so."isActive" = true '
    '  AND so."deletedAt" IS NULL '
    '  AND so."approvalStatus" = \'APPROVED\' AND pb."expiryDate" > NOW()'
    '), 0) AS stock, '
    'COALESCE(('
    '  SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r '
    '  WHERE r."catalogProductId" = cp.id'
    '), 0) AS avg_rating'
)
_PRODUCT_FROM_SQL = (
    'FROM catalog_products cp '
    'JOIN categories c ON c.id = cp."categoryId" '
)
_PRODUCT_ACTIVE_SQL = 'cp."isActive" = true AND cp."deletedAt" IS NULL'


def search_products(query: str) -> str:
    """Searches the catalogue for products, optionally within a price budget.

    query: the words that identify what the customer wants — series,
    character, product type or manufacturer — plus any budget exactly as the
    customer said it (e.g. "naruto figures under 2000", "between 500 and
    1500"); the budget is parsed out of the text and applied as a real price
    filter. Pass just the budget (e.g. "under 2000") when the customer only
    gave a budget; the whole catalogue is considered.

    Returns name, manufacturer, description, category, selling price, live
    stock across active/approved seller offers, and average review rating.
    """
    # Deliberately a single-string schema. The declared max_price/min_price
    # parameters were rejected at the SDK's argument-validation layer in
    # production ("expecting a decimal number") before this code ever ran, and
    # the model turned that into "I can't filter by price" refusals. A budget
    # inside the text is the one channel every SDK version delivers intact —
    # verified working against the live database.
    return search_products_impl(query)


def search_products_impl(query: str, max_price: Optional[float] = None, min_price: Optional[float] = None) -> str:
    """search_products with explicit price bounds — kept callable for tests
    and any future caller with a schema layer that can deliver them safely.
    Explicit bounds override any budget found in the text."""
    # Gemini has been observed sending numeric arguments as strings. Postgres
    # has no numeric <= text operator, so coerce here rather than letting the
    # database turn a valid budget into an error.
    try:
        max_price = float(max_price) if max_price is not None else None
        min_price = float(min_price) if min_price is not None else None
    except (TypeError, ValueError):
        return "Error: max_price and min_price must be numbers (rupees)."
    if max_price is None and min_price is None:
        max_price, min_price = parse_budget(query)
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    has_price_bound = max_price is not None or min_price is not None
    # A budget-only ask ("items below 2000") leaves no product words once the
    # stopwords and the budget number are stripped. Text-matching the leftovers
    # finds nothing, so with a price bound present the text filter is dropped
    # and the bound is applied to the whole catalogue instead.
    match_all = has_price_bound and not _specific_tokens(query)
    if match_all:
        score_sql = '0'
        where_sql = 'TRUE'
        params = []
    else:
        tokens = search_tokens(query)
        likes = [f"%{t}%" for t in tokens]
        # One OR-group per token: a product needs to match at least one word, not
        # the whole phrase. match_score then ranks by how much of the phrase landed,
        # weighting a name or manufacturer hit above a passing mention in the
        # description, so "naruto figure" still puts the Naruto figures on top.
        score_sql = ' + '.join(
            '(CASE WHEN cp.name ILIKE %s OR cp.manufacturer ILIKE %s THEN 2 '
            'WHEN cp.description ILIKE %s THEN 1 ELSE 0 END)'
            for _ in likes
        )
        where_sql = ' OR '.join(
            '(cp.name ILIKE %s OR cp.manufacturer ILIKE %s OR cp.description ILIKE %s)'
            for _ in likes
        )
        params = [t for t in likes for _ in range(3)] * 2
    inner_sql = (
        f'SELECT {_PRODUCT_COLUMNS_SQL}, '
        f'({score_sql}) AS match_score '
        f'{_PRODUCT_FROM_SQL}'
        f'WHERE ({where_sql}) '
        f'AND {_PRODUCT_ACTIVE_SQL}'
    )
    # Price bounds apply to the computed offer price, so they need an outer
    # query. A NULL price (no live offer) never satisfies a bound, which is
    # right: a product nobody can buy has no place in a budget answer.
    price_where = []
    if max_price is not None:
        price_where.append('t.price <= %s')
        params.append(max_price)
    if min_price is not None:
        price_where.append('t.price >= %s')
        params.append(min_price)
    sql = f'SELECT * FROM ({inner_sql}) t '
    if price_where:
        sql += 'WHERE ' + ' AND '.join(price_where) + ' '
    # Was ORDER BY cp.name: a search for "Naruto" returned the first
    # five figures alphabetically, so the assistant recommended
    # whatever sorted earliest -- often out of stock -- instead of the
    # best thing we can actually sell. Now: closest match to what was
    # asked, then in-stock, then well-reviewed.
    sql += 'ORDER BY t.match_score DESC, t.stock DESC, t.avg_rating DESC, t.name LIMIT 5'
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, tuple(params))
            rows = _normalize_product_rows(cur.fetchall())
            if rows:
                return str(rows)
            if match_all:
                return "No products found in that price range."
            if has_price_bound:
                return f"No products found matching '{query}' in that price range."
            return f"No products found matching '{query}'."
    except Exception as e:
        # The error string goes back to the model, which paraphrases it away —
        # log it too, or pm2 has no trace of what actually failed.
        print(f"search_products failed: {e}", file=sys.stderr)
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()

def search_blogs(query: str) -> str:
    """Searches published blog posts by title, excerpt, or tag."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT title, excerpt, slug FROM blog_posts '
                'WHERE status = \'PUBLISHED\' '
                'AND (title ILIKE %s OR excerpt ILIKE %s OR %s = ANY(tags)) '
                'ORDER BY "publishedAt" DESC LIMIT 5',
                (f"%{query}%", f"%{query}%", query)
            )
            rows = cur.fetchall()
            return str(rows) if rows else f"No blog posts found matching '{query}'."
    except Exception as e:
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()

def list_categories() -> str:
    """Lists the store's product categories with how many products each has
    live right now. Use when a customer asks what kinds of things Yukizi
    sells, or to help them narrow down what they want."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT c.name, COUNT(cp.id) AS live_products '
                'FROM categories c '
                'JOIN catalog_products cp ON cp."categoryId" = c.id '
                f'AND {_PRODUCT_ACTIVE_SQL} '
                'GROUP BY c.name '
                'ORDER BY live_products DESC'
            )
            rows = [dict(r) for r in cur.fetchall()]
            return str(rows) if rows else "No categories found."
    except Exception as e:
        print(f"list_categories failed: {e}", file=sys.stderr)
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()


def get_new_arrivals() -> str:
    """The newest products added to the store, with price, stock and rating.
    Use for "what's new", "latest arrivals", "anything recent"."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f'SELECT {_PRODUCT_COLUMNS_SQL}, 0 AS match_score '
                f'{_PRODUCT_FROM_SQL}'
                f'WHERE {_PRODUCT_ACTIVE_SQL} '
                'ORDER BY cp."createdAt" DESC LIMIT 5'
            )
            rows = _normalize_product_rows(cur.fetchall())
            return str(rows) if rows else "No products found."
    except Exception as e:
        print(f"get_new_arrivals failed: {e}", file=sys.stderr)
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()


def get_bestsellers() -> str:
    """The store's most-purchased products, with price, stock and rating.
    Use for "what's popular", "bestsellers", "what do people usually buy"."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f'SELECT {_PRODUCT_COLUMNS_SQL}, 0 AS match_score, '
                # Units actually bought, across every offer of the product.
                'COALESCE(('
                '  SELECT SUM(oi.quantity) FROM order_items oi '
                '  JOIN seller_offers so2 ON so2.id = oi."sellerOfferId" '
                '  WHERE so2."catalogProductId" = cp.id'
                '), 0) AS units_sold '
                f'{_PRODUCT_FROM_SQL}'
                f'WHERE {_PRODUCT_ACTIVE_SQL} '
                'ORDER BY units_sold DESC, avg_rating DESC, stock DESC LIMIT 5'
            )
            rows = _normalize_product_rows(cur.fetchall())
            for row in rows:
                row['units_sold'] = int(row['units_sold']) if row.get('units_sold') is not None else 0
            return str(rows) if rows else "No products found."
    except Exception as e:
        print(f"get_bestsellers failed: {e}", file=sys.stderr)
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()


# The store's own published facts, one fetch per hour. llms.txt is generated
# live by the storefront specifically for language models: policies, shipping
# and return windows, company identity, category/price coverage and all the
# buying guides, each with a one-line answer. Serving answers from it means
# the bot and the website can never disagree.
_STORE_INFO_CACHE = {'text': None, 'at': 0.0}
_STORE_INFO_SKIP_SECTIONS = ('products', 'recently added', 'machine-readable', 'key pages')


def _fetch_store_info_text() -> str:
    now = time.time()
    if _STORE_INFO_CACHE['text'] and now - _STORE_INFO_CACHE['at'] < 3600:
        return _STORE_INFO_CACHE['text']
    import httpx
    url = os.environ.get('STORE_INFO_URL', 'https://yukizi.com/llms.txt')
    resp = httpx.get(url, timeout=10, follow_redirects=True)
    resp.raise_for_status()
    _STORE_INFO_CACHE['text'] = resp.text
    _STORE_INFO_CACHE['at'] = now
    return resp.text


def get_store_info(topic: str) -> str:
    """Official Yukizi store facts: shipping times and coverage, returns and
    refunds, payment methods, seller verification, company details, and the
    store's buying guides (e.g. how to spot a fake figure or Funko Pop).
    topic: a few words, e.g. "return policy", "shipping time", "fake funko".
    Answer policy and authenticity questions from this, never from memory."""
    try:
        text = _fetch_store_info_text()
    except Exception as e:
        print(f"get_store_info fetch failed: {e}", file=sys.stderr)
        return "Error: store information is unavailable right now."
    sections = re.split(r'\n(?=## )', text)
    keep = [s for s in sections
            if not s.lower().lstrip('# ').startswith(_STORE_INFO_SKIP_SECTIONS)]
    words = {w for w in re.findall(r'[a-z0-9]+', (topic or '').lower()) if len(w) > 2}
    def score(section: str) -> int:
        body = section.lower()
        return sum(body.count(w) for w in words)
    ranked = sorted(keep, key=score, reverse=True)
    top = [s for s in ranked[:2] if score(s) > 0]
    if not top:
        # Nothing matched the topic: serve the first real section (Key facts),
        # not the file preamble, so the answer still carries policy substance.
        headed = [s for s in keep if s.startswith('## ')]
        top = headed[:1] or keep[:1]
    return '\n\n'.join(s.strip()[:4000] for s in top)


def get_product_reviews(product_identifier: str) -> str:
    """Looks up a product by id or name, then returns its average rating
    and a handful of recent review comments."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT id FROM catalog_products '
                'WHERE (id = %s OR name ILIKE %s) AND "isActive" = true AND "deletedAt" IS NULL '
                'ORDER BY (id = %s) DESC, name '
                'LIMIT 1',
                (product_identifier, f"%{product_identifier}%", product_identifier)
            )
            product = cur.fetchone()
            if not product:
                return f"No product found matching '{product_identifier}'."

            cur.execute(
                'SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS review_count '
                'FROM reviews WHERE "catalogProductId" = %s',
                (product['id'],)
            )
            summary = cur.fetchone()
            if not summary or not summary['review_count']:
                return "No reviews yet for this product."

            cur.execute(
                'SELECT rating, comment FROM reviews WHERE "catalogProductId" = %s '
                'AND comment IS NOT NULL ORDER BY "createdAt" DESC LIMIT 5',
                (product['id'],)
            )
            recent = cur.fetchall()

            lines = [f"Average rating: {summary['avg_rating']}/5 from {summary['review_count']} review(s)."]
            for r in recent:
                lines.append(f"- {r['rating']}/5: {r['comment']}")
            return "\n".join(lines)
    except Exception as e:
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()

def get_order_status(order_id: str) -> str:
    """Gets the status of an order given its ID."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, \"orderStatus\", \"paymentStatus\", \"totalAmount\" FROM orders WHERE id = %s", (order_id,))
            row = cur.fetchone()
            return str(row) if row else f"Order '{order_id}' not found."
    except Exception as e:
        return f"Error executing query: {str(e)}"
    finally:
        conn.close()

#: Every tool the assistant could ever be given, by the name the Studio uses.
ALL_TOOLS = {
    "search_products": search_products,
    "get_order_status": get_order_status,
    "search_blogs": search_blogs,
    "get_product_reviews": get_product_reviews,
    "list_categories": list_categories,
    "get_new_arrivals": get_new_arrivals,
    "get_bestsellers": get_bestsellers,
    "get_store_info": get_store_info,
}


def resolve_tools(names):
    """The tools this conversation is allowed to use.

    Every caller (the NestJS API) sends exactly the tools the admin left
    switched on. None therefore means a caller that bypassed the Studio, and
    it gets nothing — the previous "None means all of them" default was the
    one remaining way to sidestep every access switch, guarding a
    back-compat caller that no longer exists.

    An explicit empty list is the same real choice it always was: the admin
    switched everything off, and the assistant answers from what it was
    taught alone.
    """
    if names is None:
        return []
    return [ALL_TOOLS[n] for n in names if n in ALL_TOOLS]


def resolve_thinking_budget(requested):
    """0 is a real choice ("do not think"), not an absent value. `or 2048`
    treated them the same, so the dial the Studio calls the biggest lever on
    cost per answer could never actually reach zero."""
    return requested if requested is not None else 2048


# ==========================================
# ENDPOINTS
# ==========================================
@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "has_gemini_sdk": HAS_GEMINI,
        "has_api_key": bool(os.environ.get("GEMINI_API_KEY")),
        "active_model": ACTIVE_MODEL
    }

@app.post("/train/extract")
def extract_rule(req: ConversationTrainRequest):
    """Distills the instruction an admin just taught in a sandbox conversation
    into a short {trigger, instruction} pair. Does not persist anything —
    the caller (NestJS) shows this as an editable draft before saving."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not HAS_GEMINI or not api_key:
        raise HTTPException(status_code=500, detail="Gemini SDK/API Key not configured.")
    if len(req.history) < 2:
        raise HTTPException(status_code=400, detail="Not enough conversation history to extract a rule from.")

    transcript = "\n".join(f"{m.role}: {m.content}" for m in req.history if m.content)
    extraction_prompt = (
        "An admin just taught a customer-service chatbot a new behavior through this "
        "conversation. Distill the single instruction being taught into a short JSON "
        "object with two fields: \"trigger\" (a few words describing when this applies) "
        "and \"instruction\" (the exact behavior to follow, as an imperative sentence). "
        "Respond with ONLY the JSON object, no other text.\n\n"
        f"Conversation:\n{transcript}"
    )
    try:
        client = get_genai_client(api_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=extraction_prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        parsed = json.loads(response.text)
        trigger = str(parsed.get("trigger", "")).strip()
        instruction = str(parsed.get("instruction", "")).strip()
        if not trigger or not instruction:
            raise ValueError("Gemini returned an incomplete rule")
        return {"trigger": trigger, "instruction": instruction}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract rule: {str(e)}")

# The article the model is asked to summarise. Long enough for any real post's
# argument to be present, short enough that a runaway paste cannot blow the
# request up or bill a summary of 200k characters.
_SUMMARY_INPUT_CHARS = 12000
_SUMMARY_MIN_CHARS = 40
_SUMMARY_MAX_WORDS = 120


def html_to_text(html: str) -> str:
    """The visible text of a rich-text post.

    Block boundaries become newlines first: dropping tags naively welds the
    last word of one paragraph to the first of the next ("…display.Prices
    start…"), and the model then summarises a run-on sentence it invented.
    Entities are unescaped so the model reads ₹250, not &#8377;250.
    """
    text = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1\s*>', ' ', html or '')
    text = re.sub(r'(?i)<br\s*/?>', '\n', text)
    text = re.sub(r'(?i)</(p|div|li|tr|h[1-6]|blockquote|figcaption)\s*>', '\n', text)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html_unescape(text)
    text = re.sub(r'[ \t\r\f\v]+', ' ', text)
    text = re.sub(r'\s*\n\s*', '\n', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def clean_summary(text: str) -> str:
    """What the model returned, as the plain sentence it was asked for.

    The summary is published verbatim — on the post and in llms.txt — so a
    stray "**Summary:**" or a wrapping quote would be shown to readers and
    served to crawlers exactly as written.
    """
    out = (text or '').strip()
    out = re.sub(r'^```[a-z]*\s*|\s*```$', '', out).strip()
    out = re.sub(r'^["“\']+|["”\']+$', '', out).strip()
    out = re.sub(r'^(?:\*\*|__)?\s*(?:summary|tl;?dr)\s*:?\s*(?:\*\*|__)?\s*', '', out, flags=re.IGNORECASE)
    out = re.sub(r'[*_#`]', '', out)
    out = re.sub(r'^["“\']+|["”\']+$', '', out).strip()
    return re.sub(r'\s+', ' ', out).strip()


@app.post("/summarize")
def summarize(req: SummarizeRequest):
    """A factual summary of one blog post, written for AI search engines.

    The admin's blog editor drafts `aiSummary` with this; the storefront then
    publishes that text on the post and as the post's one-line entry in
    llms.txt, so what an assistant quotes about an article is something the
    store actually wrote rather than whatever the crawler chose to extract.
    Nothing is persisted here — the caller saves the draft after editing it.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not HAS_GEMINI or not api_key:
        raise HTTPException(status_code=500, detail="Gemini SDK/API Key not configured.")

    article = html_to_text(req.content)[:_SUMMARY_INPUT_CHARS]
    if len(article) < _SUMMARY_MIN_CHARS:
        raise HTTPException(
            status_code=400,
            detail="There is not enough content in this post to summarise yet.",
        )
    max_words = max(20, min(int(req.max_words or 60), _SUMMARY_MAX_WORDS))
    title = (req.title or '').strip()

    prompt = (
        "Write a factual summary of the article below for AI search engines "
        "(ChatGPT, Gemini, Perplexity) and for a store's llms.txt listing.\n"
        "Rules:\n"
        "- Plain declarative statements about what the article says.\n"
        "- No marketing language, no first person, no questions, no markdown.\n"
        "- State the article's main conclusions, so the summary is useful on "
        "its own to someone who never opens the page.\n"
        f"- At most {max_words} words. Reply with the summary only.\n\n"
        f"Title: {title or '(untitled)'}\n\n"
        f"Article:\n{article}"
    )

    try:
        client = get_genai_client(api_key)
        # No GenerateContentConfig: the sidecar's pinned google-genai has
        # dropped fields off config objects before (see search_products), and
        # a plain-text summary needs nothing from it.
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        summary = clean_summary(getattr(response, 'text', '') or '')
        if not summary:
            raise ValueError("Gemini returned an empty summary")
        return {"summary": summary, "words": len(summary.split())}
    except HTTPException:
        raise
    except Exception as e:
        print(f"summarize failed: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Failed to write a summary: {str(e)}")


@app.post("/chat")
async def chat(request: ChatRequest):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not HAS_GEMINI or not api_key or api_key.strip() == "":
        return {
            "response": f"[MOCK MODE] (Model: {ACTIVE_MODEL}) SDK/API key missing. You said: '{request.message}'",
            "thoughts": "[MOCK THINKING] Processed prompt in fallback mode without API key."
        }
        
    start_time = time.time()
    # Fresh bucket per request: product tools drop structured rows in here as
    # they run, and the widget renders them as tappable cards.
    products_token = _collected_products.set([])
    try:
        client = get_genai_client(api_key)
        gemini_history = []
        if request.history:
            for msg in request.history:
                role = "model" if msg.role in ["model", "assistant"] else "user"
                parts = []
                if msg.content:
                    parts.append(types.Part.from_text(text=msg.content))
                if msg.attachments:
                    for att in msg.attachments:
                        if att.data.startswith('data:'):
                            mime_type = att.data.split(';')[0].split(':')[1]
                            b64_data = att.data.split(',')[1]
                            parts.append(types.Part.from_bytes(data=base64.b64decode(b64_data), mime_type=mime_type))
                if not parts:
                    parts.append(types.Part.from_text(text="[Attachment only]"))
                gemini_history.append(types.Content(role=role, parts=parts))
        
        # Build ThinkingConfig if thinking is enabled
        thinking_config = None
        if request.thinking_enabled:
            try:
                thinking_config = types.ThinkingConfig(thinking_budget=resolve_thinking_budget(request.thinking_budget))
            except Exception as te:
                print(f"ThinkingConfig setup notice: {te}", file=sys.stderr)

        # The NestJS API always sends the Studio-compiled instruction; the
        # bare default only serves a caller that bypassed it (direct curl).
        system_instruction = request.system_instruction or DEFAULT_PROMPT
        if request.page_context:
            system_instruction += (
                '\n\nCONTEXT\nThe customer is currently on this page of the store: '
                + request.page_context[:300]
                + '\nWhen they say "this" or ask about a product without naming '
                  'one, assume they mean what this page shows.'
            )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            tools=resolve_tools(request.tools),
            thinking_config=thinking_config
        )
        
        chat_session = client.chats.create(
            model=ACTIVE_MODEL,
            config=config,
            history=gemini_history
        )
        
        current_parts = []
        if request.message:
            current_parts.append(request.message)
        if request.attachments:
            for att in request.attachments:
                if att.data.startswith('data:'):
                    mime_type = att.data.split(';')[0].split(':')[1]
                    b64_data = att.data.split(',')[1]
                    current_parts.append(types.Part.from_bytes(data=base64.b64decode(b64_data), mime_type=mime_type))
        
        if not current_parts:
            current_parts = ["Hello"]

        response = chat_session.send_message(current_parts)
        thinking_time_ms = int((time.time() - start_time) * 1000)

        # Extract thoughts (reasoning chain) and response text
        thoughts_list = []
        response_texts = []

        if hasattr(response, 'candidates') and response.candidates:
            for candidate in response.candidates:
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if getattr(part, 'thought', False):
                            if hasattr(part, 'text') and part.text:
                                thoughts_list.append(part.text)
                        elif hasattr(part, 'text') and part.text:
                            response_texts.append(part.text)

        thoughts_str = "\n".join(thoughts_list).strip() if thoughts_list else None
        final_text = "\n".join(response_texts).strip() if response_texts else (getattr(response, 'text', '') or "")

        return {
            "response": final_text,
            "thoughts": thoughts_str,
            "thinking_time_ms": thinking_time_ms,
            # Structured rows from the product tools this request ran, for the
            # widget's product cards. Empty when no product tool was used.
            "products": _collected_products.get() or []
        }
    except Exception as e:
        print(f"Error calling Gemini API: {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {
            "response": (
                "Sorry, I'm having trouble answering right now. "
                "Please try again in a moment, or contact Yukizi support if it keeps happening."
            )
        }
    finally:
        _collected_products.reset(products_token)

if __name__ == "__main__":
    port = int(os.environ.get("CHATBOT_PORT", 5005))
    host = os.environ.get("CHATBOT_HOST", "0.0.0.0")
    uvicorn.run("main:app", host=host, port=port, reload=False)
