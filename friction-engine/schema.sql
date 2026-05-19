-- Aether OS · PostgreSQL Schema · v1.0
-- Friction Engine for Indian RTI / Tender / Grievance Tracking
-- Run on PostgreSQL 15+ with pg_cron extension for scheduled jobs

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. DEPARTMENTS ─────────────────────────────────────────────────────────
CREATE TABLE departments (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name             VARCHAR(255) NOT NULL,
    short_code       VARCHAR(20)  NOT NULL UNIQUE,
    jurisdiction     VARCHAR(50)  CHECK (jurisdiction IN ('Municipal','State','Central')),
    state            VARCHAR(100),
    city             VARCHAR(100),
    portal_url       TEXT,
    scraper_config   JSONB,        -- portal-specific selector config for the scraper
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_dept_name_state UNIQUE (name, state)
);

-- ── 2. OFFICIALS ───────────────────────────────────────────────────────────
CREATE TABLE officials (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id    UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    designation      VARCHAR(150),
    contact_email    VARCHAR(255),
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (department_id, name, designation)
);

-- ── 3. INQUIRIES ───────────────────────────────────────────────────────────
CREATE TABLE inquiries (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tracking_number       VARCHAR(100) NOT NULL UNIQUE,
    department_id         UUID NOT NULL REFERENCES departments(id),
    assigned_official_id  UUID REFERENCES officials(id) ON DELETE SET NULL,
    inquiry_type          VARCHAR(50)  CHECK (inquiry_type IN ('RTI','Tender','Grievance','Other')),
    category              VARCHAR(100),
    date_filed            DATE NOT NULL,
    statutory_deadline    DATE NOT NULL,
    current_status        VARCHAR(50)  DEFAULT 'Pending'
        CHECK (current_status IN ('Pending','Transferred','Rejected','Resolved','Appealed')),
    friction_score        DECIMAL(5,2) DEFAULT 0.00,
    delay_days            INTEGER GENERATED ALWAYS AS (
        CASE WHEN current_status = 'Pending'
             THEN GREATEST(0, CURRENT_DATE - statutory_deadline)
             ELSE 0 END
    ) STORED,
    raw_ocr_text          TEXT,         -- preserve source text for reprocessing
    llm_model_version     VARCHAR(50),  -- model used for extraction
    created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ── 4. FRICTION EVENTS (append-only audit log) ─────────────────────────────
CREATE TABLE friction_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inquiry_id          UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    event_date          TIMESTAMPTZ NOT NULL,
    event_category      VARCHAR(50) NOT NULL
        CHECK (event_category IN (
            'Status_Change','Department_Transfer','Deadline_Missed',
            'Document_Requested','Rejected'
        )),
    description         TEXT,
    delay_days_incurred INTEGER DEFAULT 0,
    source_document     TEXT,    -- URL or document reference
    created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ── 5. SCRAPE LOG ──────────────────────────────────────────────────────────
CREATE TABLE scrape_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id   UUID NOT NULL REFERENCES departments(id),
    started_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    inquiries_found INTEGER DEFAULT 0,
    errors          INTEGER DEFAULT 0,
    status          VARCHAR(20) CHECK (status IN ('running','completed','failed')),
    error_message   TEXT
);

-- ── 6. DEAD LETTER QUEUE ───────────────────────────────────────────────────
CREATE TABLE dead_letter (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_text        TEXT NOT NULL,
    error_message   TEXT,
    llm_response    TEXT,
    source_portal   VARCHAR(100),
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    reviewed        BOOLEAN DEFAULT FALSE,
    reviewed_at     TIMESTAMPTZ
);

-- ── 7. ALERT THRESHOLDS ────────────────────────────────────────────────────
CREATE TABLE alert_thresholds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id   UUID REFERENCES departments(id),   -- null = global
    metric          VARCHAR(50) NOT NULL,              -- avg_friction_score, breach_rate, etc.
    threshold_value DECIMAL(6,2) NOT NULL,
    webhook_url     TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    last_triggered  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ── 8. INDEXES ─────────────────────────────────────────────────────────────
CREATE INDEX idx_inquiries_department   ON inquiries(department_id);
CREATE INDEX idx_inquiries_status       ON inquiries(current_status);
CREATE INDEX idx_inquiries_deadline     ON inquiries(statutory_deadline)
    WHERE current_status = 'Pending';
CREATE INDEX idx_inquiries_friction     ON inquiries(friction_score DESC);
CREATE INDEX idx_friction_inq           ON friction_events(inquiry_id);
CREATE INDEX idx_friction_cat           ON friction_events(event_category);
CREATE INDEX idx_friction_date          ON friction_events(event_date DESC);
CREATE INDEX idx_dead_letter_reviewed   ON dead_letter(reviewed) WHERE NOT reviewed;

-- ── 9. FRICTION SCORE REFRESH FUNCTION ────────────────────────────────────
-- Implements: F_inquiry = (α · Δt)^1.2  +  Σ(w_i · E_i)  +  P_status
-- α = 2.0  |  exponent = 1.2 (non-linear time scaling)
-- Evasion weights: Department_Transfer=15, Document_Requested=10
-- Status penalty applied once from the inquiry record: Rejected=50
-- Deadline_Missed events carry delay_days_incurred used in the time term.
CREATE OR REPLACE FUNCTION refresh_friction_score(p_inquiry_id UUID)
RETURNS VOID AS $$
DECLARE
    v_alpha         CONSTANT NUMERIC := 2.0;
    v_exponent      CONSTANT NUMERIC := 1.2;
    v_delay_days    INTEGER := 0;
    v_evasion       NUMERIC := 0;
    v_status_penalty NUMERIC := 0;
    v_time_penalty  NUMERIC := 0;
    v_final_score   NUMERIC := 0;
    v_status        VARCHAR;
BEGIN
    -- Accumulate total delay days from Deadline_Missed events
    SELECT COALESCE(SUM(delay_days_incurred), 0)
    INTO v_delay_days
    FROM friction_events
    WHERE inquiry_id = p_inquiry_id AND event_category = 'Deadline_Missed';

    -- Accumulate evasion penalty from transfer and format-request events
    SELECT COALESCE(SUM(
        CASE event_category
            WHEN 'Department_Transfer'  THEN 15
            WHEN 'Document_Requested'   THEN 10
            ELSE 0
        END
    ), 0)
    INTO v_evasion
    FROM friction_events
    WHERE inquiry_id = p_inquiry_id;

    -- Fetch current status for terminal status penalty
    SELECT current_status INTO v_status FROM inquiries WHERE id = p_inquiry_id;
    v_status_penalty := CASE v_status WHEN 'Rejected' THEN 50 ELSE 0 END;

    -- Time penalty: (α · Δt)^1.2
    IF v_delay_days > 0 THEN
        v_time_penalty := POWER(v_alpha * v_delay_days, v_exponent);
    END IF;

    -- Final score: no hard cap — administrative black holes must be visible
    v_final_score := v_time_penalty + v_evasion + v_status_penalty;

    UPDATE inquiries
    SET friction_score = ROUND(v_final_score, 2),  -- no cap: 500+ is a valid score
        updated_at     = CURRENT_TIMESTAMP
    WHERE id = p_inquiry_id;
END;
$$ LANGUAGE plpgsql;

-- ── 10. DEADLINE SWEEP (called by pg_cron every hour) ─────────────────────
CREATE OR REPLACE FUNCTION sweep_missed_deadlines()
RETURNS INTEGER AS $$
DECLARE
    r RECORD;
    count INTEGER := 0;
BEGIN
    FOR r IN
        SELECT id, statutory_deadline
        FROM inquiries
        WHERE current_status = 'Pending'
          AND CURRENT_DATE > statutory_deadline
          AND NOT EXISTS (
              SELECT 1 FROM friction_events
              WHERE inquiry_id = inquiries.id
                AND event_category = 'Deadline_Missed'
                AND event_date::date = CURRENT_DATE
          )
    LOOP
        INSERT INTO friction_events (inquiry_id, event_date, event_category, description, delay_days_incurred)
        VALUES (
            r.id,
            CURRENT_TIMESTAMP,
            'Deadline_Missed',
            'Statutory deadline exceeded — no response within mandated period.',
            CURRENT_DATE - r.statutory_deadline
        );

        PERFORM refresh_friction_score(r.id);
        count := count + 1;
    END LOOP;

    RETURN count;
END;
$$ LANGUAGE plpgsql;

-- Schedule via pg_cron (run after enabling the extension):
-- SELECT cron.schedule('deadline-sweep', '0 * * * *', 'SELECT sweep_missed_deadlines()');

-- ── 11. DEPARTMENT FRICTION VIEW ─────────────────────────────────────────
-- DFI = median(F_inquiry) + ghost_rate_pct
-- Ghost: unresolved/non-rejected inquiry past 90 days — systemic paralysis
CREATE OR REPLACE VIEW department_friction AS
WITH scores AS (
    SELECT
        i.department_id,
        i.friction_score,
        i.current_status,
        CASE
            WHEN i.current_status NOT IN ('Resolved','Rejected')
             AND CURRENT_DATE - i.statutory_deadline > 90
            THEN 1 ELSE 0
        END AS is_ghost
    FROM inquiries i
),
dept_agg AS (
    SELECT
        department_id,
        COUNT(*)                                                          AS total_n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY friction_score)      AS median_f,
        SUM(is_ghost)                                                     AS ghost_count,
        ROUND(SUM(is_ghost)::numeric / NULLIF(COUNT(*),0) * 100, 2)      AS ghost_rate,
        MAX(friction_score)                                               AS max_f,
        COUNT(*) FILTER (WHERE current_status = 'Resolved')              AS resolved_n,
        COUNT(*) FILTER (WHERE current_status = 'Rejected')              AS rejected_n
    FROM scores
    GROUP BY department_id
)
SELECT
    d.short_code,
    d.name,
    d.city,
    d.state,
    d.jurisdiction,
    da.total_n                                                            AS total_inquiries,
    da.ghost_count,
    ROUND(da.ghost_rate, 2)                                               AS ghost_rate_pct,
    ROUND(da.median_f, 2)                                                AS median_friction,
    ROUND(da.max_f, 2)                                                   AS max_friction,
    -- DFI = median(F) + ghost_rate  — the core ranking metric
    ROUND(da.median_f + da.ghost_rate, 2)                                AS dfi,
    da.resolved_n                                                         AS resolved_count,
    da.rejected_n                                                         AS rejected_count
FROM departments d
JOIN dept_agg da ON da.department_id = d.id
WHERE d.is_active
ORDER BY dfi DESC NULLS LAST;

-- ── 12. SEED: SAMPLE DEPARTMENTS ───────────────────────────────────────────
INSERT INTO departments (name, short_code, jurisdiction, state, city, portal_url) VALUES
  ('Municipal Corporation of Greater Mumbai', 'MCGM', 'Municipal', 'Maharashtra', 'Mumbai',   'https://portal.mcgm.gov.in'),
  ('Kolkata Municipal Corporation',           'KMC',  'Municipal', 'West Bengal', 'Kolkata',  'https://www.kmcgov.in'),
  ('Delhi Development Authority',             'DDA',  'Central',   'Delhi',       'Delhi',    'https://dda.gov.in'),
  ('Bruhat Bengaluru Mahanagara Palike',      'BBMP', 'Municipal', 'Karnataka',   'Bengaluru','https://bbmp.gov.in'),
  ('Pune Municipal Corporation',              'PMC',  'Municipal', 'Maharashtra', 'Pune',     'https://pmc.gov.in'),
  ('Greater Chennai Corporation',             'GCC',  'Municipal', 'Tamil Nadu',  'Chennai',  'https://chennaicorporation.gov.in')
ON CONFLICT DO NOTHING;
