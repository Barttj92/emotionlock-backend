-- Daily history for the Stats screen (redesign 2026-10). Purely additive:
-- a new table, nothing existing is changed. The backend writes one row per
-- user per Amsterdam day right before the daily reset wipes the counters,
-- and GET /history/:userId reads them back.
--
-- Older backends never touch this table, so it is safe to apply before the
-- deploy. Rollback: nothing needed; dropping the table later loses history.

CREATE TABLE IF NOT EXISTS public.daily_summaries (
    user_id        text          NOT NULL,
    day            date          NOT NULL,
    limit_mode     text          NOT NULL DEFAULT 'trades' CHECK (limit_mode IN ('trades', 'loss')),
    trades_count   integer       NOT NULL DEFAULT 0 CHECK (trades_count >= 0),
    max_trades     integer,
    net_pnl        numeric(14,2),
    max_daily_loss numeric(14,2),
    was_locked     boolean       NOT NULL DEFAULT false,
    tokens_used    integer       NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
    created_at     timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS daily_summaries_user_day_idx
    ON public.daily_summaries (user_id, day DESC);

-- Only the backend (service role) reads and writes. RLS on with no policies
-- keeps the anon and authenticated keys out entirely.
ALTER TABLE public.daily_summaries ENABLE ROW LEVEL SECURITY;
