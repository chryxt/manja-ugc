import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!process.env.F5_BOOTSTRAP_TOKEN || token !== process.env.F5_BOOTSTRAP_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.F5_TEST_USER_EMAIL;
  const password = process.env.F5_TEST_USER_PASSWORD;

  if (!supabaseUrl || !supabaseKey || !email || !password) {
    return Response.json({ error: "bootstrap_env_missing" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return Response.json({ error: error.message, code: error.code ?? null }, { status: 400 });
  }

  return Response.json({
    ok: true,
    userId: data.user?.id ?? null,
    email: data.user?.email ?? email,
    confirmedAt: data.user?.email_confirmed_at ?? null,
    hasSession: Boolean(data.session),
  });
}
