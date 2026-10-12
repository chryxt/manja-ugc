import { Sparkles } from "lucide-react";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { login } from "./actions";

const errorMessages: Record<string, string> = {
  missing_credentials: "Masukkan email dan password.",
  invalid_credentials: "Email atau password tidak valid.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/app");

  const { error } = await searchParams;
  const errorMessage = error ? errorMessages[error] : null;

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
      <section className="hidden bg-neutral-950 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-sm font-semibold tracking-wide">
          <span className="grid size-9 place-items-center rounded-xl bg-white text-neutral-950">
            <Sparkles className="size-4" />
          </span>
          MANJA UGC
        </div>
        <div className="max-w-xl pb-10">
          <p className="mb-4 text-sm font-medium text-neutral-400">CONTENT OPERATIONS</p>
          <h1 className="text-5xl font-semibold leading-tight tracking-[-0.04em]">
            Dari produk nyata menjadi workflow UGC yang terukur.
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-neutral-400">
            Product DNA, storyboard, rendering, media, dan billing lifecycle berjalan pada satu workspace yang konsisten.
          </p>
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="grid size-9 place-items-center rounded-xl bg-neutral-950 text-white">
              <Sparkles className="size-4" />
            </span>
            <span className="font-semibold">MANJA UGC</span>
          </div>

          <p className="text-sm font-medium text-neutral-500">Selamat datang kembali</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Masuk ke workspace</h2>
          <p className="mt-3 text-sm leading-6 text-neutral-500">
            Gunakan akun Supabase yang sudah memiliki akses workspace.
          </p>

          {errorMessage ? (
            <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          <form action={login} className="mt-8 space-y-5">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Email</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="nama@perusahaan.com"
                className="h-12 w-full rounded-xl border bg-white px-4 text-sm outline-none transition focus:border-neutral-400 focus:ring-4 focus:ring-neutral-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium">Password</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-12 w-full rounded-xl border bg-white px-4 text-sm outline-none transition focus:border-neutral-400 focus:ring-4 focus:ring-neutral-100"
              />
            </label>

            <button
              type="submit"
              className="h-12 w-full rounded-xl bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-4 focus:ring-neutral-200"
            >
              Masuk
            </button>
          </form>

          <p className="mt-6 text-xs leading-5 text-neutral-400">
            F1/F2 menggunakan autentikasi email/password. Signup publik belum diaktifkan pada checkpoint ini.
          </p>
        </div>
      </section>
    </main>
  );
}
