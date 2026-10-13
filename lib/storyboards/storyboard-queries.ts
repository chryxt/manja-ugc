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
  approvedAt: string | null;
  approvedBy: string | null;
  payload: Record<string, unknown>;
  scriptContent: string | null;
  visualPrompts: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  renderJobs: Array<{
    id: string;
    status: string;
    progress: number;
    currentStep: string | null;
    costSnapshot: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  generatedVideos: Array<{
    id: string;
    jobId: string;
    mimeType: string;
    durationSeconds: number | null;
    createdAt: string;
    streamUrl: string;
  }>;
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
    .select("id, product_id, payload, script_content, visual_prompts, status, approved_at, approved_by, created_at, updated_at")
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

  const { data: bindings, error: bindingError } = await supabase
    .from("job_domain_inputs")
    .select("job_id")
    .eq("workspace_id", workspace.id)
    .eq("storyboard_id", storyboardId);
  if (bindingError) throw new Error(`Failed to read storyboard job bindings: ${bindingError.message}`);

  const jobIds = [...new Set((bindings ?? []).map((binding) => binding.job_id))];
  let renderJobs: StoryboardDetail["renderJobs"] = [];
  if (jobIds.length > 0) {
    const { data: jobs, error: jobError } = await supabase
      .from("jobs")
      .select("id, status, progress, current_step, cost_snapshot, error_code, error_message, created_at, updated_at")
      .eq("workspace_id", workspace.id)
      .eq("job_type", "ugc_video")
      .in("id", jobIds)
      .order("created_at", { ascending: false });
    if (jobError) throw new Error(`Failed to read render jobs: ${jobError.message}`);
    renderJobs = (jobs ?? []).map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      currentStep: job.current_step,
      costSnapshot: job.cost_snapshot,
      errorCode: job.error_code,
      errorMessage: job.error_message,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    }));
  }

  const { data: videos, error: videoError } = await supabase
    .from("generated_videos")
    .select("id, job_id, mime_type, duration_seconds, created_at")
    .eq("workspace_id", workspace.id)
    .eq("storyboard_id", storyboardId)
    .order("created_at", { ascending: false });
  if (videoError) throw new Error(`Failed to read generated videos: ${videoError.message}`);

  return {
    id: storyboard.id,
    productId: storyboard.product_id,
    productName,
    status: storyboard.status,
    approvedAt: storyboard.approved_at,
    approvedBy: storyboard.approved_by,
    payload: asRecord(storyboard.payload),
    scriptContent: storyboard.script_content,
    visualPrompts: asRecord(storyboard.visual_prompts),
    createdAt: storyboard.created_at,
    updatedAt: storyboard.updated_at,
    renderJobs,
    generatedVideos: (videos ?? []).map((video) => ({
      id: video.id,
      jobId: video.job_id,
      mimeType: video.mime_type,
      durationSeconds: video.duration_seconds,
      createdAt: video.created_at,
      streamUrl: `/app/videos/${video.id}`,
    })),
  };
}
