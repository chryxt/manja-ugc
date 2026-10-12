"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export async function createProduct(formData: FormData) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) redirect("/app/products/new?error=no-workspace");
  if (workspace.role !== "owner" && workspace.role !== "admin") {
    redirect("/app/products/new?error=forbidden");
  }

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (name.length < 2 || name.length > 120) {
    redirect("/app/products/new?error=invalid-name");
  }
  if (description.length > 2000) {
    redirect("/app/products/new?error=description-too-long");
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("products")
    .insert({ workspace_id: workspace.id, name, description: description || null })
    .select("id")
    .single();

  if (error) {
    const code = encodeURIComponent(error.code || "create-failed");
    redirect(`/app/products/new?error=${code}`);
  }

  revalidatePath("/app");
  revalidatePath("/app/products");
  redirect(`/app/products/${data.id}`);
}
