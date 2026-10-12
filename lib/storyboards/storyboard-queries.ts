import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export type DnaReadyProduct = {
  id: string;
  name: string;
  description: string | null;
  dnaProfile: Record<string, unknown>;
  updatedAt: string;
};

export type StoryboardListItem = {
  id: string;
  productId: string | null;
  productName: string;
  status: string;
  title: string;
  platform: string;
  durationSeconds: number | null;
  createdAt: string;
};

export type StoryboardDetail = {
  id: string;
  productId: string | null;
  productName: string;
  status: string;
  payload: Record<string, unknown>;
  scriptContent: string | null;
  visualPrompts: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export async function readDnaReadyProducts(workspace: ActiveWorkspace): Promise<DnaReadyProduct[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, name, description, dna_profile, updated_at")
    .eq("workspace_id", workspace.id)
    .not("dna_profile", "is", null)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Failed to read DNA-ready products: ${error.message}`);

  return (data ?? []).flatMap((product) => {
    const dnaProfile = asRecord(product.dna_profile);
    if (Object.keys(dnaProfile).length === 0) return [];
    return [{
      id: product.id,
      name: product.name,
      description: product.description,
      dnaProfile,
      updatedAt: product.updated_at,
    }];
  });
}

export async function readRecentStoryboards(workspace: ActiveWorkspace, limit = 12): Promise<StoryboardListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data: storyboards, error } = await supabase
    .from("storyboards")
    .select("id, product_id, payload, status, created_at")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to read storyboards: ${error.message}`);
  const rows = storyboards ?? [];
  const productIds = [...new Set(rows.map((row) => row.product_id).filter((id): id is string => typeof id === "string"))];
  const names = new Map<string, string>();

  if (productIds.length > 0) {
    const { data: products, error: productError } = await supabase
      .from("products")
      .select("id, name")
      .eq("workspace_id", workspace.id)
      .in("id", productIds);
    if (productError) throw new Error(`Failed to read storyboard products: ${productError.message}`);
    for (const product of products ?? []) names.set(product.id, product.name);
  }

  return rows.map((row) => {
    const payload = asRecord(row.payload);
    const duration = Number(payload.durationSeconds);
    return {
      id: row.id,
      productId: row.product_id,
      productName: row.product_id ? names.get(row.product_id) ?? "Unknown product" : "Unbound product",
      status: row.status,
      title: asString(payload.title, "Untitled UGC concept"),
      platform: asString(payload.platform, "unknown"),
      durationSeconds: Number.isFinite(duration) ? duration : null,
      createdAt: row.created_at,
    };
  });
}

export async function readStoryboardDetail(workspace: ActiveWorkspace, storyboardId: string): Promise<StoryboardDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data: storyboard, error } = await supabase
    .from("storyboards")
    .select("id, product_id, payload, script_content, visual_prompts, status, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .eq("id", storyboardId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read storyboard: ${error.message}`);
  if (!storyboard) return null;

  let productName = "Unbound product";
  if (storyboard.product_id) {
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("name")
      .eq("workspace_id", workspace.id)
      .eq("id", storyboard.product_id)
      .maybeSingle();
    if (productError) throw new Error(`Failed to read storyboard product: ${productError.message}`);
    if (product) productName = product.name;
  }

  return {
    id: storyboard.id,
    productId: storyboard.product_id,
    productName,
    status: storyboard.status,
    payload: asRecord(storyboard.payload),
    scriptContent: storyboard.script_content,
    visualPrompts: asRecord(storyboard.visual_prompts),
    createdAt: storyboard.created_at,
    updatedAt: storyboard.updated_at,
  };
}
