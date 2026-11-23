-- D-052: count trades from the moment of the MT5 connect, not from midnight.
-- Set by POST /connect-mt5 when a user links a (new or different) MT5 account.
alter table public.purchases add column if not exists mt5_count_from_at timestamptz;
