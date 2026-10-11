import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ActiveWorkspace = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
};

export async function resolveActiveWorkspace(): Promise<ActiveWorkspace | null> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: membership, error: membershipError } = await supabase
    .from("workspace_members")
    .select("workspace_id, role, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    throw new Error(`Failed to resolve workspace membership: ${membershipError.message}`);
  }

  if (!membership) return null;

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .eq("id", membership.workspace_id)
    .maybeSingle();

  if (workspaceError) {
    throw new Error(`Failed to resolve workspace: ${workspaceError.message}`);
  }

  if (!workspace) return null;

  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role: membership.role as ActiveWorkspace["role"],
  };
}
