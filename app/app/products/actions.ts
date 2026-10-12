"use server";

import { createHash, randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { generateProductDna, type ProductDnaSourceAsset } from "@/lib/products/generate-product-dna";
import { deleteViaR2Gateway, readViaR2Gateway, uploadViaR2Gateway } from "@/lib/storage/r2-gateway";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const MAX_ASSET_BYTES = 4_000_000;
const MAX_DNA_SOURCE_ASSETS = 4;
const MAX_DNA_TOTAL_BYTES = 12_000_000;
const ASSET_TYPES = new Set(["product_closeup", "packaging", "logo_watermark", "reference"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const DNA_ASSET_PRIORITY: Record<string, number> = {
  product_closeup: 0,
  packaging: 1,
  logo_watermark: 2,
  reference: 3,
};

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
}

function sanitizeProviderMessage(value: unknown) {
  if (typeof value !== "string") return null;
  return value
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[redacted-image]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-jwt]")
    .replace(/[A-Za-z0-9_-]{96,}/g, "[redacted-long-token]")
    .slice(0, 800);
}

function readErrorField(error: unknown, field: string) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[field];
  return value;
}

function classifyProviderError(error: unknown) {
  const statusValue = readErrorField(error, "status");
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const codeValue = readErrorField(error, "code");
  const code = typeof codeValue === "string" ? codeValue.slice(0, 120) : undefined;
  const requestIdValue = readErrorField(error, "request_id") ?? readErrorField(error, "requestId");
  const requestId = typeof requestIdValue === "string" ? requestIdValue.slice(0, 180) : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = sanitizeProviderMessage(rawMessage);
  const probe = `${code ?? ""} ${message ?? ""}`.toLowerCase();

  let category = "provider_error";
  if (status === 401 || status === 403 || /auth|credential|api.?key|unauthor|forbidden/.test(probe)) category = "gateway_auth";
  else if (status === 404 || /model.*not.*found|unknown model|invalid model/.test(probe)) category = "model_not_found";
  else if (status === 408 || status === 504 || /timeout|timed out/.test(probe)) category = "timeout";
  else if (status === 429 || /rate.?limit|quota|resource_exhausted/.test(probe)) category = "rate_limit";
  else if (status === 400 || status === 422 || /invalid_request|unsupported|malformed|input_image/.test(probe)) category = "invalid_request";
  else if (status && status >= 500) category = "provider_5xx";

  return { category, status, code, requestId, message };
}

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

export async function uploadProductAsset(productId: string, formData: FormData) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) redirect(`/app/products/${productId}?error=no-workspace`);
  if (workspace.role !== "owner" && workspace.role !== "admin") {
    redirect(`/app/products/${productId}?error=forbidden`);
  }

  const assetType = String(formData.get("assetType") ?? "");
  const file = formData.get("file");

  if (!ASSET_TYPES.has(assetType)) redirect(`/app/products/${productId}?error=invalid-asset-type`);
  if (!(file instanceof File) || file.size < 1) redirect(`/app/products/${productId}?error=file-required`);
  if (file.size > MAX_ASSET_BYTES) redirect(`/app/products/${productId}?error=file-too-large`);

  const extension = MIME_EXTENSIONS[file.type];
  if (!extension) redirect(`/app/products/${productId}?error=unsupported-file-type`);

  const supabase = await createServerSupabaseClient();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("id", productId)
    .maybeSingle();

  if (productError || !product) redirect("/app/products?error=product-not-found");

  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const objectKey = `workspaces/${workspace.id}/products/${productId}/source/${assetType}/${randomUUID()}.${extension}`;

  try {
    await uploadViaR2Gateway(objectKey, buffer, file.type);
  } catch {
    redirect(`/app/products/${productId}?error=r2-unavailable`);
  }

  const { error: insertError } = await supabase.from("product_assets").insert({
    workspace_id: workspace.id,
    product_id: productId,
    asset_type: assetType,
    storage_key: objectKey,
    public_url: null,
    mime_type: file.type,
    size_bytes: file.size,
    original_filename: safeFilename(file.name || `source.${extension}`),
    checksum_sha256: checksum,
  });

  if (insertError) {
    await deleteViaR2Gateway(objectKey).catch(() => undefined);
    redirect(`/app/products/${productId}?error=asset-persist-failed`);
  }

  revalidatePath("/app");
  revalidatePath("/app/products");
  revalidatePath(`/app/products/${productId}`);
  redirect(`/app/products/${productId}?uploaded=1`);
}

export async function generateProductDnaAction(productId: string) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) redirect(`/app/products/${productId}?error=no-workspace`);
  if (workspace.role !== "owner" && workspace.role !== "admin") {
    redirect(`/app/products/${productId}?error=forbidden`);
  }

  const supabase = await createServerSupabaseClient();
  const [{ data: product, error: productError }, { data: assetRows, error: assetError }] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, description")
      .eq("workspace_id", workspace.id)
      .eq("id", productId)
      .maybeSingle(),
    supabase
      .from("product_assets")
      .select("id, asset_type, storage_key, mime_type, size_bytes, original_filename, checksum_sha256, created_at")
      .eq("workspace_id", workspace.id)
      .eq("product_id", productId)
      .order("created_at", { ascending: false }),
  ]);

  if (productError || !product) redirect("/app/products?error=product-not-found");
  if (assetError) redirect(`/app/products/${productId}?error=dna-assets-read-failed`);

  const candidates = (assetRows ?? [])
    .filter((asset) => Boolean(asset.mime_type && MIME_EXTENSIONS[asset.mime_type]))
    .sort((a, b) => (DNA_ASSET_PRIORITY[a.asset_type] ?? 99) - (DNA_ASSET_PRIORITY[b.asset_type] ?? 99));

  if (candidates.length === 0) redirect(`/app/products/${productId}?error=dna-no-assets`);

  const selected: typeof candidates = [];
  const seenTypes = new Set<string>();
  let estimatedBytes = 0;

  for (const asset of candidates) {
    if (selected.length >= MAX_DNA_SOURCE_ASSETS) break;
    const size = Number(asset.size_bytes ?? 0);
    if (size > 0 && estimatedBytes + size > MAX_DNA_TOTAL_BYTES) continue;
    if (seenTypes.has(asset.asset_type) && selected.length < Math.min(3, candidates.length)) continue;
    selected.push(asset);
    seenTypes.add(asset.asset_type);
    estimatedBytes += size;
  }

  if (selected.length === 0) redirect(`/app/products/${productId}?error=dna-assets-too-large`);

  const sources: ProductDnaSourceAsset[] = [];
  try {
    for (const asset of selected) {
      const response = await readViaR2Gateway(asset.storage_key);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error("R2 source asset is empty");
      sources.push({
        id: asset.id,
        assetType: asset.asset_type,
        mimeType: asset.mime_type as string,
        originalFilename: asset.original_filename,
        checksumSha256: asset.checksum_sha256,
        bytes,
      });
    }
  } catch {
    redirect(`/app/products/${productId}?error=dna-r2-unavailable`);
  }

  let profile;
  try {
    profile = await generateProductDna({
      name: product.name,
      description: product.description,
      assets: sources,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "AI_GATEWAY_UNAVAILABLE") redirect(`/app/products/${productId}?error=dna-ai-unavailable`);
    if (message === "PRODUCT_DNA_INVALID_RESPONSE" || message === "PRODUCT_DNA_EMPTY_RESPONSE") {
      const diagnosticId = randomUUID().slice(0, 8);
      console.error(JSON.stringify({
        event: "product_dna_provider_error",
        diagnosticId,
        category: "malformed_response",
        workspaceId: workspace.id,
        productId,
        sourceAssetCount: sources.length,
        sourceBytes: sources.reduce((total, asset) => total + asset.bytes.length, 0),
        message,
      }));
      redirect(`/app/products/${productId}?error=dna-invalid-response&diag=${diagnosticId}&provider=malformed_response`);
    }

    const diagnosticId = randomUUID().slice(0, 8);
    const diagnostic = classifyProviderError(error);
    console.error(JSON.stringify({
      event: "product_dna_provider_error",
      diagnosticId,
      category: diagnostic.category,
      status: diagnostic.status ?? null,
      code: diagnostic.code ?? null,
      requestId: diagnostic.requestId ?? null,
      workspaceId: workspace.id,
      productId,
      sourceAssetCount: sources.length,
      sourceBytes: sources.reduce((total, asset) => total + asset.bytes.length, 0),
      message: diagnostic.message,
    }));

    const params = new URLSearchParams({
      error: "dna-generation-failed",
      diag: diagnosticId,
      provider: diagnostic.category,
    });
    if (diagnostic.status) params.set("status", String(diagnostic.status));
    redirect(`/app/products/${productId}?${params.toString()}`);
  }

  const { error: updateError } = await supabase
    .from("products")
    .update({ dna_profile: profile })
    .eq("workspace_id", workspace.id)
    .eq("id", productId);

  if (updateError) redirect(`/app/products/${productId}?error=dna-persist-failed`);

  revalidatePath("/app");
  revalidatePath("/app/products");
  revalidatePath(`/app/products/${productId}`);
  redirect(`/app/products/${productId}?dna=generated`);
}
