import { ArrowUpRight, Boxes, CircleCheck, Clock3, WalletCards } from "lucide-react";

import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export default async function DashboardPage() {
  const workspace = await resolveActiveWorkspace();

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-500">Dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">
              {workspace ? `Selamat datang di ${workspace.name}` : "Workspace belum terhubung"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
              {workspace
                ? "Frontend foundation aktif. Data operasional berikutnya akan dibaca dari PostgreSQL sebagai authoritative state."
                : "Login berhasil, tetapi user ini belum memiliki membership workspace yang dapat dibaca melalui RLS."}
            </p>
          </div>

          <div className="rounded-full border bg-white px-3 py-1.5 text-xs font-medium text-neutral-500">
            F1 + F2 checkpoint
          </div>
        </div>

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Products", value: "—", icon: Boxes },
            { label: "Active jobs", value: "—", icon: Clock3 },
            { label: "Completed", value: "—", icon: CircleCheck },
            { label: "Credits", value: "—", icon: WalletCards },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.label} className="rounded-2xl border bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                <div className="flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-xl bg-neutral-100 text-neutral-600">
                    <Icon className="size-4" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">F3</span>
                </div>
                <p className="mt-6 text-2xl font-semibold">{item.value}</p>
                <p className="mt-1 text-sm text-neutral-500">{item.label}</p>
              </article>
            );
          })}
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
          <article className="rounded-2xl border bg-white p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Foundation status</p>
                <p className="mt-1 text-sm text-neutral-500">UI hanya membaca state; job dan finance mutation tetap server-authoritative.</p>
              </div>
              <CircleCheck className="size-5 text-emerald-600" />
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                "Supabase session boundary",
                "Protected /app route",
                "Workspace membership resolver",
                "Server-side logout",
              ].map((label) => (
                <div key={label} className="flex items-center gap-2 rounded-xl bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                  <CircleCheck className="size-4 text-emerald-600" />
                  {label}
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-2xl bg-neutral-950 p-6 text-white">
            <p className="text-sm font-semibold">Next checkpoint</p>
            <p className="mt-3 text-xl font-semibold leading-7">Products + real dashboard reads</p>
            <p className="mt-3 text-sm leading-6 text-neutral-400">
              F3/F4 baru dimulai setelah authentication shell ini tervalidasi di deployment.
            </p>
            <div className="mt-6 flex items-center gap-2 text-xs font-medium text-neutral-300">
              F3 / F4
              <ArrowUpRight className="size-3.5" />
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
