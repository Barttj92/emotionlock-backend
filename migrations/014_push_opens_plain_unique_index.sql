-- 014_push_opens_plain_unique_index.sql
--
-- POST /push-opened upserts with onConflict 'push_send_id,user_id'. Postgres
-- only accepts that when a unique index exists on exactly those columns; the
-- index from 006 is on (push_send_id, lower(user_id)), so every open failed
-- with 42P10 and push_opens stayed empty. The backend now lowercases user_id
-- before writing, so both indexes stay consistent.
--
-- Applied via Supabase migration `push_opens_plain_unique_index` on 2026-10-30.

CREATE UNIQUE INDEX IF NOT EXISTS push_opens_send_user_plain_idx
    ON public.push_opens (push_send_id, user_id);
