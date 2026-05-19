#!/usr/bin/env bash
# Aether OS — One-command bootstrap
# Usage: ./setup.sh
# Requires: Node >= 20, Python 3.11+, a DATABASE_URL in .env

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
step() { echo -e "\n${YELLOW}▶  $*${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
fail() { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

cd "$(dirname "$0")"   # run from friction-engine/ regardless of cwd

# ── 0. Check prerequisites ───────────────────────────────────────────────────
step "Checking prerequisites"

command -v node   >/dev/null 2>&1 || fail "Node.js not found (need >= 20)"
command -v python3 >/dev/null 2>&1 || fail "Python 3 not found"
command -v npm    >/dev/null 2>&1 || fail "npm not found"

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
[ "$NODE_VER" -ge 20 ] || fail "Node.js >= 20 required (found v${NODE_VER})"

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}{sys.version_info.minor}')")
[ "$PY_VER" -ge 311 ] || fail "Python 3.11+ required"

[ -f .env ] || fail ".env file not found. Copy .env.example and fill in DATABASE_URL and ANTHROPIC_API_KEY."
ok "Prerequisites OK"

# ── 1. Node dependencies ─────────────────────────────────────────────────────
step "Installing Node dependencies"
npm install --legacy-peer-deps
ok "Node dependencies installed"

# ── 2. Python dependencies ───────────────────────────────────────────────────
step "Installing Python dependencies"
pip install -q -r requirements.txt
ok "Python dependencies installed"

# ── 3. Playwright browser ────────────────────────────────────────────────────
step "Installing Playwright Chromium"
python3 -m playwright install chromium --with-deps
ok "Playwright Chromium ready"

# ── 4. Prisma: generate client + push schema ─────────────────────────────────
step "Generating Prisma client"
npx prisma generate
ok "Prisma client generated"

step "Pushing schema to database"
npx prisma db push --skip-generate
ok "Database schema applied"

# ── 5. Seed database ─────────────────────────────────────────────────────────
step "Seeding database (departments + global alert thresholds)"
npx tsx prisma/seed.ts
ok "Database seeded"

# ── 6. Apply pg_cron schedule (optional, requires superuser) ─────────────────
step "Applying pg_cron schedule for deadline sweep"
DB_URL="${DATABASE_URL:-}"
if [ -n "$DB_URL" ]; then
  psql "$DB_URL" -c "
    SELECT cron.schedule(
      'deadline-sweep',
      '0 * * * *',
      'SELECT sweep_missed_deadlines()'
    );" 2>/dev/null && ok "pg_cron job scheduled" \
    || echo -e "${YELLOW}  ↳ pg_cron not available — schedule manually if needed${NC}"
else
  echo "  ↳ DATABASE_URL not set — skipping pg_cron step"
fi

# ── 7. Smoke test ────────────────────────────────────────────────────────────
step "Smoke test: DB connection"
python3 -c "
import asyncio, asyncpg, os
from dotenv import load_dotenv
load_dotenv()
async def check():
    conn = await asyncpg.connect(os.environ['DATABASE_URL'])
    depts = await conn.fetchval('SELECT COUNT(*) FROM departments')
    print(f'  departments in DB: {depts}')
    await conn.close()
asyncio.run(check())
"
ok "Database connection OK"

echo ""
echo -e "${GREEN}✓ Aether OS bootstrap complete.${NC}"
echo ""
echo "Next steps:"
echo "  • Start dev server:      npm run dev"
echo "  • Run scraper manually:  python3 scraper.py --mode both"
echo "  • Preview emails:        npm run email:preview"
echo "  • Run nightly cron:      curl -H 'Authorization: Bearer \$CRON_SECRET' \$NEXT_PUBLIC_SITE_URL/api/v1/internal/trigger-friction-update"
echo ""
