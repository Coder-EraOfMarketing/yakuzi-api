import os
import sys
import time
import traceback
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
PROMPT_FILE = os.path.join(BASE_DIR, "system_prompt.txt")
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
ACTIVE_SYSTEM_INSTRUCTION = load_text_file(PROMPT_FILE, DEFAULT_PROMPT)
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

class ConversationTrainRequest(BaseModel):
    history: List[ChatMessage]
    custom_name: Optional[str] = "yukizi-custom-bot"


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

def search_products(query: str) -> str:
    """Searches the database for products matching the query, including
    description, category, live stock across active/approved seller offers,
    and average review rating."""
    conn = get_db_connection()
    if not conn: return "Error: Could not connect to database."
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT cp.name, cp.manufacturer, cp.mrp, cp.description, '
                'c.name AS category, '
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
                '), 0) AS avg_rating '
                'FROM catalog_products cp '
                'JOIN categories c ON c.id = cp."categoryId" '
                'WHERE (cp.name ILIKE %s OR cp.manufacturer ILIKE %s OR cp.description ILIKE %s) '
                'AND cp."isActive" = true AND cp."deletedAt" IS NULL '
                'ORDER BY cp.name LIMIT 5',
                (f"%{query}%", f"%{query}%", f"%{query}%")
            )
            rows = cur.fetchall()
            # RealDictCursor returns Decimal for numeric columns (mrp, avg_rating).
            # str(Decimal(...)) renders as Python constructor syntax
            # (e.g. "Decimal('499.00')"), which Gemini could echo verbatim into a
            # customer-facing reply, so cast to plain floats before stringifying.
            for row in rows:
                row['mrp'] = float(row['mrp']) if row['mrp'] is not None else None
                row['avg_rating'] = float(row['avg_rating']) if row['avg_rating'] is not None else None
            return str(rows) if rows else f"No products found matching '{query}'."
    except Exception as e:
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

# ==========================================
# LEARNED RULES (structured training)
# ==========================================
def get_active_rules() -> list:
    """Reads active ChatbotRule rows fresh on every call — no caching, so an
    admin toggling a rule off takes effect on the very next chat message.
    Ordered the way the admin arranged them: CORE tier first (Postgres enum
    order follows declaration order, CORE before SURFACE), then the manual
    per-tier "order", then creation time as the tiebreak."""
    conn = get_db_connection()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'SELECT trigger, instruction, tier FROM chatbot_rules '
                'WHERE "isActive" = true ORDER BY tier ASC, "order" ASC, "createdAt" ASC LIMIT 100'
            )
            return cur.fetchall()
    except Exception as e:
        print(f"Error fetching chatbot rules: {e}", file=sys.stderr)
        return []
    finally:
        conn.close()


#: Every tool the assistant could ever be given, by the name the Studio uses.
ALL_TOOLS = {
    "search_products": search_products,
    "get_order_status": get_order_status,
    "search_blogs": search_blogs,
    "get_product_reviews": get_product_reviews,
}


def resolve_tools(names):
    """The tools this conversation is allowed to use.

    None means the caller predates the Studio's access switches, so it gets
    everything — that was the behaviour before, and silently taking tools away
    from an old caller would look like the assistant had gone stupid.

    An explicit empty list is a real choice: the admin switched everything off,
    and the assistant must answer from what it was taught alone.
    """
    if names is None:
        return list(ALL_TOOLS.values())
    return [ALL_TOOLS[n] for n in names if n in ALL_TOOLS]


def build_system_instruction() -> str:
    """Base persona (never modified by training) plus a bounded, structured
    list of admin-taught rules — replaces the old model of appending raw
    conversation transcripts directly into system_prompt.txt forever.
    CORE rules are presented as foundational; SURFACE rules layer on top."""
    base = load_text_file(PROMPT_FILE, DEFAULT_PROMPT)
    rules = get_active_rules()
    if not rules:
        return base
    core = [r for r in rules if r.get('tier') == 'CORE']
    surface = [r for r in rules if r.get('tier') != 'CORE']
    rules_block = "\n\nLEARNED RULES (store-specific behavior taught by an admin):"
    if core:
        rules_block += "\nCore rules (foundational — these take priority):\n" + "\n".join(
            f"- {r['trigger']}: {r['instruction']}" for r in core
        )
    if surface:
        rules_block += "\nAdditional rules:\n" + "\n".join(
            f"- {r['trigger']}: {r['instruction']}" for r in surface
        )
    return base + rules_block


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

@app.post("/train/reset")
def reset_training_memory():
    global ACTIVE_SYSTEM_INSTRUCTION
    ACTIVE_SYSTEM_INSTRUCTION = DEFAULT_PROMPT
    with open(PROMPT_FILE, 'w', encoding='utf-8') as f:
        f.write(DEFAULT_PROMPT)
    return {
        "message": "Training memory successfully cleared and reset to default system prompt.",
        "active_prompt": ACTIVE_SYSTEM_INSTRUCTION
    }

@app.post("/chat")
async def chat(request: ChatRequest):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not HAS_GEMINI or not api_key or api_key.strip() == "":
        return {
            "response": f"[MOCK MODE] (Model: {ACTIVE_MODEL}) SDK/API key missing. You said: '{request.message}'",
            "thoughts": "[MOCK THINKING] Processed prompt in fallback mode without API key."
        }
        
    start_time = time.time()
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
                thinking_config = types.ThinkingConfig(thinking_budget=request.thinking_budget or 2048)
            except Exception as te:
                print(f"ThinkingConfig setup notice: {te}", file=sys.stderr)

        config = types.GenerateContentConfig(
            system_instruction=request.system_instruction or build_system_instruction(),
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
            "thinking_time_ms": thinking_time_ms
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

if __name__ == "__main__":
    port = int(os.environ.get("CHATBOT_PORT", 5005))
    host = os.environ.get("CHATBOT_HOST", "0.0.0.0")
    uvicorn.run("main:app", host=host, port=port, reload=False)
