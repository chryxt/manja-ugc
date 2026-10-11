import { LogOut, Menu } from "lucide-react";
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/app-shell/sidebar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";
import { logout } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const workspace = await resolveActiveWorkspace();

  return (
    <div className="min-h-screen bg-[#f7f7f5] lg:flex">
      <Sidebar workspace={workspace} />

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-16 items-center border-b bg-white/90 px-5 backdrop-blur sm:px-7">
          <button type="button" className="mr-3 grid size-9 place-items-center rounded-lg border lg:hidden" aria-label="Open navigation">
            <Menu className="size-4" />
          </button>

          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{workspace?.name ?? "MANJA UGC"}</p>
            <p className="truncate text-xs text-neutral-400">{user.email}</p>
          </div>

          <form action={logout} className="ml-auto">
            <button
              type="submit"
              className="flex h-9 items-center gap-2 rounded-lg border bg-white px-3 text-sm font-medium text-neutral-600 transition hover:bg-neutral-50"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Keluar</span>
            </button>
          </form>
        </header>

        {children}
      </div>
    </div>
  );
}
