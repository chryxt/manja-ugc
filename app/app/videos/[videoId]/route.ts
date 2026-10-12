import { NextResponse } from "next/server";

import { readViaR2Gateway } from "@/lib/storage/r2-gateway";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

export async function GET(_: Request, context: { params: Promise<{ videoId: string }> }) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) return new NextResponse("Unauthorized", { status: 401 });

  const { videoId } = await context.params;
  const supabase = await createServerSupabaseClient();
  const { data: video, error } = await supabase
    .from("generated_videos")
    .select("id, storage_key, mime_type")
    .eq("workspace_id", workspace.id)
    .eq("id", videoId)
    .maybeSingle();

  if (error || !video) return new NextResponse("Not found", { status: 404 });

  try {
    const upstream = await readViaR2Gateway(video.storage_key);
    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": video.mime_type || upstream.headers.get("content-type") || "video/mp4",
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch {
    return new NextResponse("Video unavailable", { status: 502 });
  }
}
