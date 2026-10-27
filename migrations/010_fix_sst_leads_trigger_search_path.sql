-- Security advisor 0011 (function_search_path_mutable).
-- Pin the search_path of the sst_leads trigger function so it cannot be
-- hijacked by objects in a schema earlier on a caller's search_path.
-- The body only uses NOW(), which lives in pg_catalog and always resolves.
-- Applied to production via Supabase MCP on 2026-10-27.
ALTER FUNCTION public.update_sst_leads_updated_at() SET search_path = '';
