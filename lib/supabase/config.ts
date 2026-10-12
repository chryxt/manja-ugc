const MANJA_UGC_SUPABASE_URL = "https://lraeniijsyubkimxnuoq.supabase.co";
const MANJA_UGC_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_1IWNrZcx5Ci_eaNLk3cLTA_wo_mgP6J";

/**
 * Canonical public Supabase configuration for the MANJA UGC web app.
 *
 * The project URL and publishable key are intentionally public client
 * configuration. Authorization remains enforced by Supabase Auth + RLS.
 * Keeping these values canonical prevents stale Preview environment variables
 * from silently pointing authentication at a different Supabase project.
 */
export function getSupabaseConfig() {
  return {
    url: MANJA_UGC_SUPABASE_URL,
    key: MANJA_UGC_SUPABASE_PUBLISHABLE_KEY,
  };
}
