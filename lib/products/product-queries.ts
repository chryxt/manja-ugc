import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export type ProductListItem = {
  id: string;
  name: string;
  description: string | null;
  dnaReady: boolean;
  assetCount: number;
  latestJobStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductDetail = {
  id: string;
  name: string;
  description: string | null;
  dnaProfile: Record<string, unknown> | null;
  dnaSourceJobId: string | null;
  createdAt: string;
  updatedAt: string;
  assets: Array<{
    id: string;
    assetType: string;
    publicUrl: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    createdAt: string;
  }>;
  jobs: Array<{
    id: string;
    jobType: string;
    status: string;
    progress: number;
    createdAt: string;
    updatedAt: string;
  }>;
};

export async function readProducts(workspace: ActiveWorkspace): Promise<ProductListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, description, dna_profile, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Failed to read products: ${error.message}`);
  const rows = products ?? [];
  if (rows.length === 0) return [];

  const productIds = rows.map((product) => product.id);
  const [{ data: assets, error: assetError }, { data: bindings, error: bindingError }] = await Promise.all([
    supabase.from("product_assets").select("product_id").eq("workspace_id", workspace.id).in("product_id", productIds),
    supabase.from("job_domain_inputs").select("job_id, product_id").eq("workspace_id", workspace.id).in("product_id", productIds),
  ]);
  if (assetError) throw new Error(`Failed to read product assets: ${assetError.message}`);
  if (bindingError) throw new Error(`Failed to read product jobs: ${bindingError.message}`);

  const assetCounts = new Map<string, number>();
  for (const asset of assets ?? []) assetCounts.set(asset.product_id, (assetCounts.get(asset.product_id) ?? 0) + 1);

  const jobIds = [...new Set((bindings ?? []).map((binding) => binding.job_id))];
  const jobsById = new Map<string, { status: string; updated_at: string }>();
  if (jobIds.length > 0) {
    const { data: jobs, error: jobError } = await supabase
      .from("jobs")
      .select("id, status, updated_at")
      .eq("workspace_id", workspace.id)
      .in("id", jobIds);
    if (jobError) throw new Error(`Failed to read product job state: ${jobError.message}`);
    for (const job of jobs ?? []) jobsById.set(job.id, job);
  }

  const latestByProduct = new Map<string, { status: string; updated_at: string }>();
  for (const binding of bindings ?? []) {
    if (!binding.product_id) continue;
    const job = jobsById.get(binding.job_id);
    if (!job) continue;
    const current = latestByProduct.get(binding.product_id);
    if (!current || current.updated_at < job.updated_at) latestByProduct.set(binding.product_id, job);
  }

  return rows.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    dnaReady: product.dna_profile !== null,
    assetCount: assetCounts.get(product.id) ?? 0,
    latestJobStatus: latestByProduct.get(product.id)?.status ?? null,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  }));
}

export async function readProductDetail(workspace: ActiveWorkspace, productId: string): Promise<ProductDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, description, dna_profile, dna_source_job_id, created_at, updated_at")
    .eq("workspace_id", workspace.id)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read product: ${error.message}`);
  if (!product) return null;

  const [{ data: assets, error: assetError }, { data: bindings, error: bindingError }] = await Promise.all([
    supabase
      .from("product_assets")
      .select("id, asset_type, public_url, mime_type, size_bytes, created_at")
      .eq("workspace_id", workspace.id)
      .eq("product_id", productId)
      .order("created_at", { ascending: false }),
    supabase
      .from("job_domain_inputs")
      .select("job_id")
      .eq("workspace_id", workspace.id)
      .eq("product_id", productId),
  ]);
  if (assetError) throw new Error(`Failed to read product assets: ${assetError.message}`);
  if (bindingError) throw new Error(`Failed to read product jobs: ${bindingError.message}`);

  const jobIds = [...new Set((bindings ?? []).map((binding) => binding.job_id))];
  let jobs: ProductDetail["jobs"] = [];
  if (jobIds.length > 0) {
    const { data: jobRows, error: jobError } = await supabase
      .from("jobs")
      .select("id, job_type, status, progress, created_at, updated_at")
      .eq("workspace_id", workspace.id)
      .in("id", jobIds)
      .order("created_at", { ascending: false });
    if (jobError) throw new Error(`Failed to read product jobs: ${jobError.message}`);
    jobs = (jobRows ?? []).map((job) => ({ id: job.id, jobType: job.job_type, status: job.status, progress: job.progress, createdAt: job.created_at, updatedAt: job.updated_at }));
  }

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    dnaProfile: product.dna_profile as Record<string, unknown> | null,
    dnaSourceJobId: product.dna_source_job_id,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
    assets: (assets ?? []).map((asset) => ({ id: asset.id, assetType: asset.asset_type, publicUrl: asset.public_url, mimeType: asset.mime_type, sizeBytes: asset.size_bytes, createdAt: asset.created_at })),
    jobs,
  };
}
