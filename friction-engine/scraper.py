#!/usr/bin/env python3
"""
Aether OS — RTI Portal Scraper
Scrapes RTI status from Indian government portals via Playwright.
Extracts structured data via Claude API. Writes to PostgreSQL.

Requirements:
    pip install playwright anthropic asyncpg pydantic python-dotenv
    playwright install chromium
"""

import asyncio
import json
import logging
import os
import random
import sys
from datetime import datetime
from pathlib import Path

import anthropic
import asyncpg
from dotenv import load_dotenv
from playwright.async_api import async_playwright, TimeoutError as PwTimeout
from pydantic import BaseModel, ValidationError, field_validator

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("aether")


# ── PORTAL REGISTRY ─────────────────────────────────────────────────────────

PORTALS = [
    {
        "short_code": "MCGM",
        "name":       "Municipal Corporation of Greater Mumbai",
        "base_url":   "https://portal.mcgm.gov.in",
        "search_path":"/rti/status_check",
        "selectors": {
            "tracking_input": "input[name='rti_no']",
            "submit_btn":     "button[type='submit']",
            "status_cell":    ".rti-status-value",
            "response_text":  ".rti-reply-content",
            "officer_name":   ".pio-name",
        },
    },
    {
        "short_code": "KMC",
        "name":       "Kolkata Municipal Corporation",
        "base_url":   "https://www.kmcgov.in",
        "search_path":"/rti/track",
        "selectors": {
            "tracking_input": "#regNo",
            "submit_btn":     "#submitBtn",
            "status_cell":    "td.status-col",
            "response_text":  "div.response-text",
            "officer_name":   "span.officer-name",
        },
    },
    {
        "short_code": "CENTRAL",
        "name":       "Central RTI Portal",
        "base_url":   "https://rtionline.gov.in",
        "search_path":"/request/view_status.php",
        "selectors": {
            "tracking_input": "#regNo",
            "submit_btn":     "input[type='submit']",
            "status_cell":    ".req_status",
            "response_text":  ".appeal_remarks",
            "officer_name":   None,
        },
    },
]


# ── PYDANTIC MODELS ──────────────────────────────────────────────────────────

class FrictionEvent(BaseModel):
    event_date: str | None = None
    event_category: str
    description: str
    delay_days_incurred: int = 0

    @field_validator("event_category")
    @classmethod
    def validate_category(cls, v: str) -> str:
        allowed = {
            "Status_Change", "Department_Transfer", "Deadline_Missed",
            "Document_Requested", "Rejected",
        }
        if v not in allowed:
            raise ValueError(f"Invalid event_category: {v!r}")
        return v


class InquiryData(BaseModel):
    type: str = "RTI"
    category: str | None = None
    date_filed: str | None = None
    statutory_deadline: str | None = None
    current_status: str = "Pending"

    @field_validator("current_status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        allowed = {"Pending", "Transferred", "Rejected", "Resolved", "Appealed"}
        return v if v in allowed else "Pending"

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        allowed = {"RTI", "Tender", "Grievance", "Other"}
        return v if v in allowed else "Other"


class InquiryExtraction(BaseModel):
    tracking_number: str | None = None
    department: dict
    official: dict
    inquiry_data: InquiryData
    friction_events: list[FrictionEvent] = []


# ── SCRAPER ──────────────────────────────────────────────────────────────────

async def scrape_single(playwright, portal: dict, tracking_id: str) -> dict | None:
    """
    Scrape one RTI record from a portal.
    Returns a dict with raw_text and metadata, or None on failure.
    """
    browser = await playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )
    ctx = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 720},
        java_script_enabled=True,
        locale="en-IN",
    )
    try:
        page = await ctx.new_page()
        url = portal["base_url"] + portal["search_path"]
        await page.goto(url, wait_until="networkidle", timeout=30_000)

        sel = portal["selectors"]
        await page.fill(sel["tracking_input"], tracking_id)

        # Stochastic pre-submit pause — evades primitive rate detection
        await asyncio.sleep(random.uniform(1.8, 5.2))
        await page.click(sel["submit_btn"])
        await page.wait_for_load_state("networkidle", timeout=25_000)

        parts: list[str] = [f"Tracking ID: {tracking_id}"]

        if sel.get("status_cell"):
            el = await page.query_selector(sel["status_cell"])
            if el:
                parts.append(f"Status: {(await el.inner_text()).strip()}")

        if sel.get("officer_name"):
            el = await page.query_selector(sel["officer_name"])
            if el:
                parts.append(f"Officer: {(await el.inner_text()).strip()}")

        if sel.get("response_text"):
            el = await page.query_selector(sel["response_text"])
            if el:
                parts.append(f"Response:\n{(await el.inner_text()).strip()}")

        raw_text = "\n".join(parts)
        log.info("  ✓ scraped %s (%d chars)", tracking_id, len(raw_text))

        return {
            "tracking_number": tracking_id,
            "portal_code":     portal["short_code"],
            "raw_text":        raw_text,
            "scraped_at":      datetime.utcnow().isoformat(),
        }

    except PwTimeout:
        log.warning("  ✗ timeout: %s @ %s", tracking_id, portal["name"])
        return None
    except Exception as exc:
        log.error("  ✗ error %s: %s", tracking_id, exc)
        return None
    finally:
        await browser.close()


async def scrape_portal_batch(
    playwright, portal: dict, tracking_ids: list[str]
) -> list[dict]:
    results = []
    for tid in tracking_ids:
        await asyncio.sleep(random.uniform(3.5, 9.0))   # inter-request jitter
        result = await scrape_single(playwright, portal, tid)
        if result:
            results.append(result)
    return results


# ── LLM EXTRACTION ───────────────────────────────────────────────────────────

_anthropic = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
_prompt_template = Path(__file__).parent / "extract-prompt.txt"
SYSTEM_PROMPT = _prompt_template.read_text() if _prompt_template.exists() else ""

_dead_letter = Path(__file__).parent / "dead_letter"
_dead_letter.mkdir(exist_ok=True)


def extract_structured(raw: dict) -> InquiryExtraction | None:
    """
    Send raw scraped text to Claude API.
    Returns validated InquiryExtraction or None (dead-letter on failure).
    """
    if not SYSTEM_PROMPT:
        log.error("extract-prompt.txt not found — cannot extract")
        return None

    user_text = SYSTEM_PROMPT.replace("[INSERT_OCR_TEXT_HERE]", raw["raw_text"])

    message = _anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        temperature=0,
        system="Output only valid JSON matching the provided schema. No prose. No markdown.",
        messages=[{"role": "user", "content": user_text}],
    )

    response_text = message.content[0].text.strip()

    # Strip markdown fences if the model wraps anyway
    if response_text.startswith("```"):
        response_text = response_text.split("```")[1]
        if response_text.startswith("json"):
            response_text = response_text[4:]

    try:
        data = json.loads(response_text)
        extraction = InquiryExtraction(
            tracking_number=data.get("tracking_number") or raw["tracking_number"],
            department=data.get("department", {}),
            official=data.get("official", {}),
            inquiry_data=InquiryData(**data.get("inquiry_data", {})),
            friction_events=[FrictionEvent(**e) for e in data.get("friction_events", [])],
        )
        return extraction

    except (json.JSONDecodeError, ValidationError, KeyError) as exc:
        ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
        path = _dead_letter / f"{raw['tracking_number'].replace('/','-')}_{ts}.json"
        path.write_text(json.dumps({
            "tracking_number": raw["tracking_number"],
            "raw_text":        raw["raw_text"],
            "llm_response":    response_text,
            "error":           str(exc),
        }, indent=2, ensure_ascii=False))
        log.warning("  ✗ extraction failed → dead_letter/%s", path.name)
        return None


# ── DATABASE ─────────────────────────────────────────────────────────────────

async def upsert(conn: asyncpg.Connection, extraction: InquiryExtraction, dept_id: str):
    """Upsert inquiry record and append any new friction events."""
    rti = extraction.inquiry_data

    inquiry_id: str = await conn.fetchval(
        """
        INSERT INTO inquiries
            (tracking_number, department_id, inquiry_type, category,
             date_filed, statutory_deadline, current_status, llm_model_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tracking_number) DO UPDATE
            SET current_status    = EXCLUDED.current_status,
                updated_at        = CURRENT_TIMESTAMP
        RETURNING id
        """,
        extraction.tracking_number,
        dept_id,
        rti.type,
        rti.category,
        rti.date_filed,
        rti.statutory_deadline,
        rti.current_status,
        "claude-sonnet-4-6",
    )

    for ev in extraction.friction_events:
        await conn.execute(
            """
            INSERT INTO friction_events
                (inquiry_id, event_date, event_category, description, delay_days_incurred)
            VALUES ($1, $2::timestamptz, $3, $4, $5)
            ON CONFLICT DO NOTHING
            """,
            inquiry_id,
            ev.event_date,
            ev.event_category,
            ev.description,
            ev.delay_days_incurred,
        )

    await conn.execute("SELECT refresh_friction_score($1)", inquiry_id)
    log.info("  → DB: %s written (status=%s)", extraction.tracking_number, rti.current_status)


# ── MAIN PIPELINE ─────────────────────────────────────────────────────────────

async def main():
    ids_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tracking_ids.txt")
    if not ids_file.exists():
        log.error("tracking_ids.txt not found. Pass path as first argument.")
        sys.exit(1)

    tracking_ids = [l.strip() for l in ids_file.read_text().splitlines() if l.strip()]
    log.info("Loaded %d tracking IDs", len(tracking_ids))

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    log.info("Connected to PostgreSQL")

    async with async_playwright() as pw:
        for portal in PORTALS:
            log.info("\n▶  Portal: %s", portal["name"])

            dept_id = await conn.fetchval(
                "SELECT id FROM departments WHERE short_code = $1",
                portal["short_code"],
            )
            if not dept_id:
                log.warning("  Department %s not found in DB — skipping", portal["short_code"])
                continue

            # Log scrape run
            run_id = await conn.fetchval(
                """
                INSERT INTO scrape_log (department_id, started_at, status)
                VALUES ($1, $2, 'running') RETURNING id
                """,
                dept_id, datetime.utcnow(),
            )

            raw_records = await scrape_portal_batch(pw, portal, tracking_ids)
            extracted_ok = 0
            errors = 0

            for raw in raw_records:
                extraction = extract_structured(raw)
                if extraction:
                    await upsert(conn, extraction, dept_id)
                    extracted_ok += 1
                else:
                    errors += 1

            await conn.execute(
                """
                UPDATE scrape_log
                SET completed_at   = $1,
                    status         = 'completed',
                    inquiries_found = $2,
                    errors         = $3
                WHERE id = $4
                """,
                datetime.utcnow(), extracted_ok, errors, run_id,
            )
            log.info("  ✓ %d extracted, %d errors", extracted_ok, errors)

    await conn.close()
    log.info("\n✓ Pipeline complete.")


if __name__ == "__main__":
    asyncio.run(main())
