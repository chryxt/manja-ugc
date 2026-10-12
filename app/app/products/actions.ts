"use server";

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getR2Storage } from "@/lib/storage/r2-server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const MAX_ASSET_BYTES = 4_000_000;
const ASSET_TYPES = new Set(["product_closeup", "packaging", "logo_watermark", "reference"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
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

  let storage;
  try {
    storage = getR2Storage();
    await storage.uploadFromStream(objectKey, Readable.from(buffer), file.type, {
      workspace_id: workspace.id,
      product_id: productId,
      asset_type: assetType,
      checksum_sha256: checksum,
    });
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
    await storage.deleteObject(objectKey).catch(() => undefined);
    redirect(`/app/products/${productId}?error=asset-persist-failed`);
  }

  revalidatePath("/app");
  revalidatePath("/app/products");
  revalidatePath(`/app/products/${productId}`);
  redirect(`/app/products/${productId}?uploaded=1`);
}
