import { readViaR2Gateway } from "@/lib/storage/r2-gateway";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { data: asset, error } = await supabase
    .from("product_assets")
    .select("id, storage_key, mime_type")
    .eq("id", assetId)
    .maybeSingle();

  if (error || !asset) return new Response("Not found", { status: 404 });

  try {
    const upstream = await readViaR2Gateway(asset.storage_key);
    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") || asset.mime_type || "application/octet-stream");
    headers.set("cache-control", "private, max-age=300");
    const etag = upstream.headers.get("etag");
    if (etag) headers.set("etag", etag);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return new Response("Asset unavailable", { status: 502 });
  }
}
