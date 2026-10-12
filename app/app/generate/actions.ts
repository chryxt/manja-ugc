"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { generateUgcStoryboard, type UgcPlatform, type UgcTone } from "@/lib/storyboards/generate-ugc-storyboard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveActiveWorkspace } from "@/lib/workspaces/resolve-workspace";

const PLATFORMS = new Set<UgcPlatform>(["tiktok", "shopee_video"]);
const TONES = new Set<UgcTone>(["natural", "energetic", "problem_solution", "testimonial"]);
const DURATIONS = new Set([15, 30, 45]);

function sanitizeProviderMessage(value: unknown) {
  if (typeof value !== "string") return null;
  return value
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-jwt]")
    .slice(0, 800);
}

function readErrorField(error: unknown, field: string) {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[field];
}

function classifyProviderError(error: unknown) {
  const statusValue = readErrorField(error, "status");
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const codeValue = readErrorField(error, "code");
  const code = typeof codeValue === "string" ? codeValue.slice(0, 120) : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = sanitizeProviderMessage(rawMessage);
  const probe = `${code ?? ""} ${message ?? ""}`.toLowerCase();

  let category = "provider_error";
  if (status === 401 || status === 403 || /api.?key|credential|unauthor|forbidden/.test(probe)) category = "provider_auth";
  else if (status === 404 || /model.*not.*found|unknown model|not found/.test(probe)) category = "model_not_found";
  else if (status === 408 || status === 504 || /timeout|timed out/.test(probe)) category = "timeout";
  else if (status === 429 || /rate.?limit|quota|resource_exhausted/.test(probe)) category = "rate_limit";
  else if (status === 400 || status === 422 || /invalid|unsupported|malformed/.test(probe)) category = "invalid_request";
  else if (status && status >= 500) category = "provider_5xx";

  return { category, status, code, message };
}

function safeReason(input: { category: string; status?: number; code?: string; message: string | null }) {
  const probe = `${input.code ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (input.category === "model_not_found") return "model_not_found";
  if (input.category === "rate_limit") return "quota_or_rate_limit";
  if (input.category === "timeout") return "provider_timeout";
  if (/api.?key/.test(probe) && /invalid|expired|permission/.test(probe)) return "invalid_api_key";
  if (input.status === 403) return "provider_forbidden";
  if (input.status === 401) return "invalid_api_key";
  if (/scene_count/.test(probe)) return "invalid_scene_count";
  if (/empty_response|invalid_response/.test(probe)) return "malformed_response";
  return "provider_rejected";
}

export async function generateStoryboardAction(formData: FormData) {
  const workspace = await resolveActiveWorkspace();
  if (!workspace) redirect("/app/generate?error=no-workspace");
  if (workspace.role !== "owner" && workspace.role !== "admin") redirect("/app/generate?error=forbidden");

  const productId = String(formData.get("productId") ?? "").trim();
  const platformValue = String(formData.get("platform") ?? "").trim() as UgcPlatform;
  const toneValue = String(formData.get("tone") ?? "").trim() as UgcTone;
  const duration = Number(formData.get("durationSeconds"));
  const creativeAngle = String(formData.get("creativeAngle") ?? "").trim().slice(0, 240);

  if (!productId) redirect("/app/generate?error=product-required");
  if (!PLATFORMS.has(platformValue)) redirect("/app/generate?error=invalid-platform");
  if (!TONES.has(toneValue)) redirect("/app/generate?error=invalid-tone");
  if (!DURATIONS.has(duration)) redirect("/app/generate?error=invalid-duration");

  const supabase = await createServerSupabaseClient();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, name, description, dna_profile")
    .eq("workspace_id", workspace.id)
    .eq("id", productId)
    .maybeSingle();

  if (productError || !product) redirect("/app/generate?error=product-not-found");
  if (!product.dna_profile || typeof product.dna_profile !== "object" || Array.isArray(product.dna_profile)) {
    redirect(`/app/generate?error=dna-required&product=${encodeURIComponent(productId)}`);
  }

  let storyboard;
  try {
    storyboard = await generateUgcStoryboard({
      productName: product.name,
      productDescription: product.description,
      dnaProfile: product.dna_profile as Record<string, unknown>,
      platform: platformValue,
      durationSeconds: duration,
      tone: toneValue,
      creativeAngle,
    });
  } catch (error) {
    const diagnosticId = randomUUID().slice(0, 8);
    const diagnostic = classifyProviderError(error);
    const reason = safeReason(diagnostic);
    console.error(JSON.stringify({
      event: "ugc_storyboard_provider_error",
      diagnosticId,
      category: diagnostic.category,
      reason,
      status: diagnostic.status ?? null,
      code: diagnostic.code ?? null,
      workspaceId: workspace.id,
      productId,
      platform: platformValue,
      durationSeconds: duration,
      message: diagnostic.message,
    }));

    const params = new URLSearchParams({ error: "storyboard-generation-failed", diag: diagnosticId, provider: diagnostic.category, reason });
    if (diagnostic.status) params.set("status", String(diagnostic.status));
    redirect(`/app/generate?${params.toString()}`);
  }

  const visualPrompts = {
    scenes: storyboard.scenes.map((scene) => ({
      scene: scene.scene,
      visual: scene.visual,
      camera: scene.camera,
      onScreenText: scene.onScreenText,
      guardrail: scene.guardrail,
    })),
  };

  const payload = {
    ...storyboard,
    productDnaSnapshot: {
      summary: (product.dna_profile as Record<string, unknown>).summary ?? null,
      positioning: (product.dna_profile as Record<string, unknown>).positioning ?? null,
      observedClaims: (product.dna_profile as Record<string, unknown>).observedClaims ?? [],
      sellingPoints: (product.dna_profile as Record<string, unknown>).sellingPoints ?? [],
      cautions: (product.dna_profile as Record<string, unknown>).cautions ?? [],
      visualIdentity: (product.dna_profile as Record<string, unknown>).visualIdentity ?? {},
    },
  };

  const { data: inserted, error: insertError } = await supabase
    .from("storyboards")
    .insert({
      workspace_id: workspace.id,
      product_id: productId,
      payload,
      script_content: storyboard.fullVoiceover,
      visual_prompts: visualPrompts,
      status: "draft",
    })
    .select("id")
    .single();

  if (insertError || !inserted) redirect("/app/generate?error=storyboard-persist-failed");

  revalidatePath("/app/generate");
  revalidatePath(`/app/generate/${inserted.id}`);
  redirect(`/app/generate/${inserted.id}?created=1`);
}
