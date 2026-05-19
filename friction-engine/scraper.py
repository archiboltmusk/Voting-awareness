#!/usr/bin/env python3
"""
Aether OS — RTI Portal Scraper
Scrapes RTI status from Indian government portals via Playwright.
Extracts structured data via Claude API. Writes to PostgreSQL.

Modes:
  discover  Find new RTI IDs from portal listing pages, scrape only new ones
  all       Re-scrape all tracking IDs already in the database
  both      Discover new IDs AND re-scrape all known IDs (default)
"""

import argparse
import asyncio
import json
import logging
import os
import random
import re
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
        "list_path":  "/rti/recent",           # listing page for discovery
        "id_pattern": r"RTI/\d{4}/\d{4,6}",   # regex to match tracking IDs in HTML
        "selectors": {
            "tracking_input": "input[name='rti_no']",
            "submit_btn":     "button[type='submit']",
            "status_cell":    ".rti-status-value",
            "response_text":  ".rti-reply-content",
            "officer_name":   ".pio-name",
            "list_items":     ".rti-list-item .tracking-no",
        },
    },
    {
        "short_code": "KMC",
        "name":       "Kolkata Municipal Corporation",
        "base_url":   "https://www.kmcgov.in",
        "search_path":"/rti/track",
        "list_path":  "/rti/list",
        "id_pattern": r"KMC/RTI/\d{4}/\d{5}",
        "selectors": {
            "tracking_input": "#regNo",
            "submit_btn":     "#submitBtn",
            "status_cell":    "td.status-col",
            "response_text":  "div.response-text",
            "officer_name":   "span.officer-name",
            "list_items":     "table.rti-table td.reg-no",
        },
    },
    {
        "short_code": "DDA",
        "name":       "Delhi Development Authority",
        "base_url":   "https://dda.gov.in",
        "search_path":"/rti/status",
        "list_path":  "/rti/applications",
        "id_pattern": r"DDA/RTI/\d{4}/\d{5}",
        "selectors": {
            "tracking_input": "input#rtiNumber",
            "submit_btn":     "button.search-btn",
            "status_cell":    "#statusResult",
            "response_text":  "#responseDiv",
            "officer_name":   "#pioName",
            "list_items":     ".application-row .app-id",
        },
    },
    {
        "short_code": "BBMP",
        "name":       "Bruhat Bengaluru Mahanagara Palike",
        "base_url":   "https://bbmp.gov.in",
        "search_path":"/rti/check-status",
        "list_path":  "/rti/applications-list",
        "id_pattern": r"BBMP/\d{4}/RTI/\d{5}",
        "selectors": {
            "tracking_input": "input[placeholder*='RTI']",
            "submit_btn":     "input[type='submit']",
            "status_cell":    "#rti_status",
            "response_text":  ".reply-box",
            "officer_name":   ".officer-details span",
            "list_items":     "ul.rti-apps li span.app-no",
        },
    },
    {
        "short_code": "PMC",
        "name":       "Pune Municipal Corporation",
        "base_url":   "https://pmc.gov.in",
        "search_path":"/rti/application-status",
        "list_path":  "/rti/recent-applications",
        "id_pattern": r"PMC/RTI/\d{4}/\d{5}",
        "selectors": {
            "tracking_input": "#rti_reg_no",
            "submit_btn":     "#check_status",
            "status_cell":    ".current-status",
            "response_text":  ".response-content",
            "officer_name":   ".pio-details",
            "list_items":     "table#recentRTI td.regNo",
        },
    },
    {
        "short_code": "GCC",
        "name":       "Greater Chennai Corporation",
        "base_url":   "https://chennaicorporation.gov.in",
        "search_path":"/rti/status-enquiry",
        "list_path":  "/rti/applications",
        "id_pattern": r"GCC/RTI/\d{4}/\d{5}",
        "selectors": {
            "tracking_input": "input[name='rtiNo']",
            "submit_btn":     "button[name='submit']",
            "status_cell":    "#rtiStatusCell",
            "response_text":  "#responseSection",
            "officer_name":   "#officerName",
            "list_items":     ".rti-grid .cell-id",
        },
    },
    {
        "short_code": "CENTRAL",
        "name":       "Central RTI Portal",
        "base_url":   "https://rtionline.gov.in",
        "search_path":"/request/view_status.php",
        "list_path":  "/request/list.php",
        "id_pattern": r"DOPTR/R/\d{4}/\d{5}",
        "selectors": {
            "tracking_input": "#regNo",
            "submit_btn":     "input[type='submit']",
            "status_cell":    ".req_status",
            "response_text":  ".appeal_remarks",
            "officer_name":   None,
            "list_items":     "table.rti-list td.reg-col",
        },
    },
]

PORTAL_MAP = {p["short_code"]: p for p in PORTALS}


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


# ── DISCOVERY ────────────────────────────────────────────────────────────────

async def discover_tracking_ids(
    playwright, portal: dict, conn: asyncpg.Connection
) -> list[str]:
    """
    Scrape the portal's listing/recent-applications page to find tracking IDs
    not yet in our database. Returns only genuinely new IDs.
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
        locale="en-IN",
    )
    found: list[str] = []
    try:
        page = await ctx.new_page()
        list_url = portal["base_url"] + portal["list_path"]
        log.info("  Discovering: %s", list_url)
        await page.goto(list_url, wait_until="networkidle", timeout=30_000)

        # Strategy 1: use portal-specific CSS selector for list items
        sel = portal["selectors"].get("list_items")
        if sel:
            elements = await page.query_selector_all(sel)
            for el in elements:
                text = (await el.inner_text()).strip()
                if text:
                    found.append(text)

        # Strategy 2: fall back to regex extraction over full page HTML
        if not found and portal.get("id_pattern"):
            html = await page.content()
            found = list(set(re.findall(portal["id_pattern"], html)))

        log.info("  Found %d candidate IDs on listing page", len(found))

    except PwTimeout:
        log.warning("  Timeout fetching listing page for %s", portal["name"])
    except Exception as exc:
        log.error("  Discovery error for %s: %s", portal["name"], exc)
    finally:
        await browser.close()

    if not found:
        return []

    # Filter to IDs not yet in the DB
    existing = set(
        await conn.fetch(
            "SELECT tracking_number FROM inquiries WHERE tracking_number = ANY($1::text[])",
            found,
        )
    )
    existing_numbers = {r["tracking_number"] for r in existing}
    new_ids = [tid for tid in found if tid not in existing_numbers]
    log.info("  %d new IDs after deduplication (of %d found)", len(new_ids), len(found))
    return new_ids


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


async def load_known_ids(conn: asyncpg.Connection, portal_code: str) -> list[str]:
    """Fetch all tracking IDs in the DB that belong to this portal."""
    dept_id = await conn.fetchval(
        "SELECT id FROM departments WHERE short_code = $1", portal_code
    )
    if not dept_id:
        return []
    rows = await conn.fetch(
        "SELECT tracking_number FROM inquiries WHERE department_id = $1", dept_id
    )
    return [r["tracking_number"] for r in rows]


# ── MAIN PIPELINE ─────────────────────────────────────────────────────────────

async def run_portal(
    pw, portal: dict, conn: asyncpg.Connection, mode: str
) -> tuple[int, int]:
    """Process one portal. Returns (extracted_ok, errors)."""
    log.info("\n▶  Portal: %s  [mode=%s]", portal["name"], mode)

    dept_id = await conn.fetchval(
        "SELECT id FROM departments WHERE short_code = $1", portal["short_code"]
    )
    if not dept_id:
        log.warning("  Department %s not in DB — skipping", portal["short_code"])
        return 0, 0

    # Gather tracking IDs to scrape according to mode
    ids_to_scrape: list[str] = []

    if mode in ("discover", "both"):
        new_ids = await discover_tracking_ids(pw, portal, conn)
        ids_to_scrape.extend(new_ids)

    if mode in ("all", "both"):
        known = await load_known_ids(conn, portal["short_code"])
        # Avoid duplicating IDs already queued from discovery
        queued = set(ids_to_scrape)
        ids_to_scrape.extend(tid for tid in known if tid not in queued)

    if not ids_to_scrape:
        log.info("  No IDs to scrape for %s", portal["short_code"])
        return 0, 0

    log.info("  %d IDs to scrape", len(ids_to_scrape))

    # Log scrape run
    run_id = await conn.fetchval(
        "INSERT INTO scrape_log (department_id, started_at, status) "
        "VALUES ($1, $2, 'running') RETURNING id",
        dept_id, datetime.utcnow(),
    )

    raw_records = await scrape_portal_batch(pw, portal, ids_to_scrape)
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
        SET completed_at    = $1,
            status          = 'completed',
            inquiries_found = $2,
            errors          = $3
        WHERE id = $4
        """,
        datetime.utcnow(), extracted_ok, errors, run_id,
    )
    log.info("  ✓ %d extracted, %d errors", extracted_ok, errors)
    return extracted_ok, errors


async def main():
    parser = argparse.ArgumentParser(description="Aether OS RTI Scraper")
    parser.add_argument(
        "--mode",
        choices=["discover", "all", "both"],
        default="both",
        help=(
            "discover = find new IDs from portal listing pages only; "
            "all = re-scrape all known IDs in DB; "
            "both = discover new + re-scrape known (default)"
        ),
    )
    parser.add_argument(
        "--portals",
        nargs="*",
        default=None,
        help="Limit to specific portal short codes (e.g. --portals MCGM KMC). "
             "Defaults to all registered portals.",
    )
    args = parser.parse_args()

    active_portals = (
        [PORTAL_MAP[code] for code in args.portals if code in PORTAL_MAP]
        if args.portals
        else PORTALS
    )
    if not active_portals:
        log.error("No matching portals found. Available: %s", list(PORTAL_MAP.keys()))
        sys.exit(1)

    log.info("Aether OS Scraper  mode=%s  portals=%s",
             args.mode, [p["short_code"] for p in active_portals])

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    log.info("Connected to PostgreSQL")

    total_ok = 0
    total_err = 0

    async with async_playwright() as pw:
        for portal in active_portals:
            ok, err = await run_portal(pw, portal, conn, args.mode)
            total_ok += ok
            total_err += err

    await conn.close()
    log.info("\n✓ Pipeline complete — %d extracted, %d errors", total_ok, total_err)

    if total_err > 0 and total_ok == 0:
        sys.exit(1)   # signal CI failure only when nothing succeeded


if __name__ == "__main__":
    asyncio.run(main())
