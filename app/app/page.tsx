import {
  AlertTriangle,
  Boxes,
  CircleCheck,
  Clock3,
  Coins,
  LoaderCircle,
  WalletCards,
} from "lucide-react";

import { readWorkspaceDashboard, type DashboardJob } from "@/lib/dashboard/read-dashboard";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const STATUS_LABELS: Record<DashboardJob["status"], string> = {
  queued: "Queued",
  processing: "Processing",
  waiting_provider: "Waiting provider",
  rendering: "Rendering",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<DashboardJob["status"], string> = {
  queued: "bg-neutral-100 text-neutral-700",
  processing: "bg-blue-50 text-blue-700",
  waiting_provider: "bg-amber-50 text-amber-700",
  rendering: "bg-violet-50 text-violet-700",
  completed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-500",
};

export default async function DashboardPage() {
  const workspace = await resolveActiveWorkspace();

  if (!workspace) {
    return (
      <main className="p-5 sm:p-7 lg:p-9">
        <div className="mx-auto max-w-6xl rounded-2xl border bg-white p-8">
          <p className="text-sm font-medium text-neutral-500">Dashboard</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">Workspace belum terhubung</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-500">
            Login berhasil, tetapi user ini belum memiliki membership workspace yang dapat dibaca melalui RLS.
          </p>
        </div>
      </main>
    );
  }

  const dashboard = await readWorkspaceDashboard(workspace);
  const creditsLabel = dashboard.credits ? dashboard.credits.available.toLocaleString("id-ID") : "—";

  const cards = [
    { label: "Products", value: dashboard.productCount.toLocaleString("id-ID"), icon: Boxes },
    { label: "Active jobs", value: dashboard.activeJobCount.toLocaleString("id-ID"), icon: Clock3 },
    { label: "Completed", value: dashboard.completedJobCount.toLocaleString("id-ID"), icon: CircleCheck },
    { label: "Available credits", value: creditsLabel, icon: WalletCards },
  ];

  return (
    <main className="p-5 sm:p-7 lg:p-9">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-neutral-500">Dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">{workspace.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
              Ringkasan operasional dibaca langsung dari PostgreSQL melalui Supabase RLS. Dashboard ini read-only.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-medium text-neutral-500">
              {workspace.role}
            </span>
            <span className="rounded-full bg-neutral-950 px-3 py-1.5 text-xs font-medium text-white">F3 live reads</span>
          </div>
        </div>

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.label} className="rounded-2xl border bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                <div className="flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-xl bg-neutral-100 text-neutral-600">
                    <Icon className="size-4" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-300">Live</span>
                </div>
                <p className="mt-6 text-2xl font-semibold">{item.value}</p>
                <p className="mt-1 text-sm text-neutral-500">{item.label}</p>
              </article>
            );
          })}
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[1.45fr_0.55fr]">
          <article className="overflow-hidden rounded-2xl border bg-white">
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
              <div>
                <p className="text-sm font-semibold">Recent jobs</p>
                <p className="mt-1 text-xs text-neutral-500">6 job terbaru di workspace ini.</p>
              </div>
              <span className="text-xs font-medium text-neutral-400">{dashboard.recentJobs.length} shown</span>
            </div>

            {dashboard.recentJobs.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <LoaderCircle className="mx-auto size-5 text-neutral-300" />
                <p className="mt-3 text-sm font-medium">Belum ada job</p>
                <p className="mt-1 text-sm text-neutral-500">Job Product DNA dan UGC akan muncul di sini saat dibuat.</p>
              </div>
            ) : (
              <div className="divide-y">
                {dashboard.recentJobs.map((job) => (
                  <div key={job.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{formatJobType(job.jobType)}</p>
                        <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${STATUS_CLASSES[job.status]}`}>
                          {STATUS_LABELS[job.status]}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-neutral-400">{job.id}</p>
                    </div>
                    <div className="flex items-center gap-5 text-xs text-neutral-500">
                      <div>
                        <p className="font-medium text-neutral-700">{job.progress}%</p>
                        <p>progress</p>
                      </div>
                      <div>
                        <p className="font-medium text-neutral-700">{job.costSnapshot.toLocaleString("id-ID")}</p>
                        <p>credits</p>
                      </div>
                      <div className="hidden sm:block">
                        <p className="font-medium text-neutral-700">{formatDate(job.createdAt)}</p>
                        <p>created</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>

          <div className="grid gap-4">
            <article className="rounded-2xl border bg-white p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Credit account</p>
                  <p className="mt-1 text-xs text-neutral-500">Visible to owner/admin via RLS.</p>
                </div>
                <Coins className="size-5 text-neutral-400" />
              </div>

              {dashboard.credits ? (
                <div className="mt-6 space-y-3 text-sm">
                  <MetricRow label="Balance" value={dashboard.credits.balance.toLocaleString("id-ID")} />
                  <MetricRow label="Reserved" value={dashboard.credits.reserved.toLocaleString("id-ID")} />
                  <MetricRow label="Available" value={dashboard.credits.available.toLocaleString("id-ID")} strong />
                </div>
              ) : (
                <div className="mt-6 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-500">
                  Credit data tidak tersedia untuk role ini atau account belum dibuat.
                </div>
              )}
            </article>

            <article className="rounded-2xl border bg-white p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold">Job health</p>
                  <p className="mt-1 text-xs text-neutral-500">Snapshot dari authoritative job state.</p>
                </div>
                {dashboard.failedJobCount > 0 ? (
                  <AlertTriangle className="size-5 text-amber-500" />
                ) : (
                  <CircleCheck className="size-5 text-emerald-600" />
                )}
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <MetricRow label="Active" value={dashboard.activeJobCount.toLocaleString("id-ID")} />
                <MetricRow label="Completed" value={dashboard.completedJobCount.toLocaleString("id-ID")} />
                <MetricRow label="Failed" value={dashboard.failedJobCount.toLocaleString("id-ID")} strong={dashboard.failedJobCount > 0} />
              </div>
            </article>
          </div>
        </section>
      </div>
    </main>
  );
}

function MetricRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 pb-3 last:border-0 last:pb-0">
      <span className="text-neutral-500">{label}</span>
      <span className={strong ? "font-semibold text-neutral-950" : "font-medium text-neutral-700"}>{value}</span>
    </div>
  );
}

function formatJobType(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
