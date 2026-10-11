import {
  Boxes,
  Clapperboard,
  Gauge,
  Images,
  Settings,
  Sparkles,
} from "lucide-react";

import type { ActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const navigation = [
  { label: "Dashboard", icon: Gauge, active: true },
  { label: "Products", icon: Boxes, active: false },
  { label: "Generate", icon: Sparkles, active: false },
  { label: "Jobs", icon: Clapperboard, active: false },
  { label: "Media", icon: Images, active: false },
];

export function Sidebar({ workspace }: { workspace: ActiveWorkspace | null }) {
  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r bg-white px-4 py-5 lg:flex lg:flex-col">
      <div className="flex items-center gap-3 px-2">
        <span className="grid size-9 place-items-center rounded-xl bg-neutral-950 text-white">
          <Sparkles className="size-4" />
        </span>
        <div>
          <p className="text-sm font-semibold">MANJA UGC</p>
          <p className="text-xs text-neutral-400">Content workspace</p>
        </div>
      </div>

      <div className="mt-7 rounded-xl border bg-neutral-50 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Workspace</p>
        <p className="mt-1 truncate text-sm font-semibold">{workspace?.name ?? "Belum ada workspace"}</p>
        {workspace ? (
          <p className="mt-0.5 text-xs capitalize text-neutral-500">{workspace.role} · {workspace.slug}</p>
        ) : (
          <p className="mt-0.5 text-xs text-neutral-500">Hubungkan user ke workspace untuk mulai.</p>
        )}
      </div>

      <nav className="mt-6 space-y-1">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={
                item.active
                  ? "flex h-10 items-center gap-3 rounded-lg bg-neutral-950 px-3 text-sm font-medium text-white"
                  : "flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-neutral-500"
              }
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
              {!item.active ? <span className="ml-auto text-[10px] uppercase text-neutral-300">Soon</span> : null}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto flex h-10 items-center gap-3 px-3 text-sm text-neutral-400">
        <Settings className="size-4" />
        Settings
        <span className="ml-auto text-[10px] uppercase text-neutral-300">Soon</span>
      </div>
    </aside>
  );
}
