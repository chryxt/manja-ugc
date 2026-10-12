"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Clapperboard, Gauge, Images, Settings, Sparkles } from "lucide-react";

import type { ActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const navigation = [
  { label: "Dashboard", icon: Gauge, href: "/app", enabled: true },
  { label: "Products", icon: Boxes, href: "/app/products", enabled: true },
  { label: "Generate", icon: Sparkles, href: "/app/generate", enabled: true },
  { label: "Jobs", icon: Clapperboard, href: "/app/jobs", enabled: false },
  { label: "Media", icon: Images, href: "/app/media", enabled: false },
];

export function Sidebar({ workspace }: { workspace: ActiveWorkspace | null }) {
  const pathname = usePathname();

  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r bg-white px-4 py-5 lg:flex lg:flex-col">
      <div className="flex items-center gap-3 px-2">
        <span className="grid size-9 place-items-center rounded-xl bg-neutral-950 text-white"><Sparkles className="size-4" /></span>
        <div><p className="text-sm font-semibold">MANJA UGC</p><p className="text-xs text-neutral-400">Content workspace</p></div>
      </div>

      <div className="mt-7 rounded-xl border bg-neutral-50 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Workspace</p>
        <p className="mt-1 truncate text-sm font-semibold">{workspace?.name ?? "Belum ada workspace"}</p>
        {workspace ? <p className="mt-0.5 text-xs capitalize text-neutral-500">{workspace.role} · {workspace.slug}</p> : <p className="mt-0.5 text-xs text-neutral-500">Hubungkan user ke workspace untuk mulai.</p>}
      </div>

      <nav className="mt-6 space-y-1">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
          const className = active ? "flex h-10 items-center gap-3 rounded-lg bg-neutral-950 px-3 text-sm font-medium text-white" : "flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-900";
          if (!item.enabled) return <div key={item.label} className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-neutral-400"><Icon className="size-4" /><span>{item.label}</span><span className="ml-auto text-[10px] uppercase text-neutral-300">Soon</span></div>;
          return <Link key={item.label} href={item.href} className={className}><Icon className="size-4" /><span>{item.label}</span></Link>;
        })}
      </nav>

      <div className="mt-auto flex h-10 items-center gap-3 px-3 text-sm text-neutral-400"><Settings className="size-4" /> Settings <span className="ml-auto text-[10px] uppercase text-neutral-300">Soon</span></div>
    </aside>
  );
}
