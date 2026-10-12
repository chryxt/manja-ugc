export type UgcPlatform = "tiktok" | "shopee_video";
export type UgcTone = "natural" | "energetic" | "problem_solution" | "testimonial";

export type UgcStoryboardScene = {
  scene: number;
  durationSeconds: number;
  purpose: string;
  visual: string;
  camera: string;
  voiceover: string;
  onScreenText: string;
  evidenceUsed: string[];
  guardrail: string;
};

export type UgcStoryboard = {
  title: string;
  platform: UgcPlatform;
  durationSeconds: number;
  tone: UgcTone;
  creativeAngle: string;
  objective: string;
  hook: string;
  cta: string;
  scenes: UgcStoryboardScene[];
  fullVoiceover: string;
  caption: string;
  hashtags: string[];
  evidenceSummary: string[];
  cautions: string[];
  generatedAt: string;
  model: string;
  dnaLineage: {
    generatedAt: string | null;
    model: string | null;
    sourceAssetIds: string[];
  };
};

type GenerateInput = {
  productName: string;
  productDescription: string | null;
  dnaProfile: Record<string, unknown>;
  platform: UgcPlatform;
  durationSeconds: number;
  tone: UgcTone;
  creativeAngle: string;
};

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

function readApiKey() {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    null
  );
}

function providerError(message: string, status?: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  if (status) error.status = status;
  if (code) error.code = code;
  return error;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 16)
    : [];
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw providerError("UGC_STORYBOARD_INVALID_RESPONSE", 502, "UGC_STORYBOARD_INVALID_RESPONSE");
  }
  return parsed as Record<string, unknown>;
}

function sceneCountForDuration(durationSeconds: number) {
  if (durationSeconds <= 15) return 3;
  if (durationSeconds <= 30) return 4;
  return 6;
}

function buildPrompt(input: GenerateInput) {
  const dna = input.dnaProfile;
  const observedClaims = asStringArray(dna.observedClaims);
  const cautions = asStringArray(dna.cautions);
  const sellingPoints = asStringArray(dna.sellingPoints);
  const opportunities = asStringArray(dna.inferredOpportunities);
  const visualIdentity = asRecord(dna.visualIdentity);
  const expectedScenes = sceneCountForDuration(input.durationSeconds);

  return [
    "You are a senior Indonesian UGC performance creative strategist for vertical ecommerce video.",
    "Create a production-ready UGC script and storyboard using Product DNA as the authoritative context.",
    "PRODUCT ACCURACY LOCK IS MANDATORY:",
    "- Never convert inferred opportunities into factual product claims.",
    "- Never add ingredients, certifications, halal status, health/medical benefits, expiry, origin, weight, flavor, guarantees, discounts, or performance claims unless explicitly present in supplied evidence.",
    "- If a caution conflicts with a potential claim, obey the caution.",
    "- evidenceUsed in every scene must quote or closely paraphrase only evidence available in Product DNA / operator description.",
    "- guardrail must state what the creator must avoid implying in that scene.",
    "Use natural Indonesian suitable for a real creator, not corporate copy.",
    `Platform: ${input.platform === "tiktok" ? "TikTok" : "Shopee Video"}`,
    `Target duration: ${input.durationSeconds} seconds`,
    `Expected scene count: exactly ${expectedScenes}`,
    `Tone: ${input.tone}`,
    `Creative angle requested: ${input.creativeAngle || "natural product discovery"}`,
    `Product: ${input.productName}`,
    `Operator description: ${input.productDescription || "(none)"}`,
    `Product DNA summary: ${asString(dna.summary, "(none)")}`,
    `Category: ${asString(dna.category, "(none)")}`,
    `Positioning: ${asString(dna.positioning, "(none)")}`,
    `Target audience: ${JSON.stringify(asStringArray(dna.targetAudience))}`,
    `Evidence-grounded selling points: ${JSON.stringify(sellingPoints)}`,
    `Observed claims: ${JSON.stringify(observedClaims)}`,
    `Marketing opportunities (INFERENCE ONLY): ${JSON.stringify(opportunities)}`,
    `Cautions / prohibited unsupported claims: ${JSON.stringify(cautions)}`,
    `Visual identity: ${JSON.stringify(visualIdentity)}`,
    "Return ONLY valid JSON with this exact conceptual structure:",
    JSON.stringify({
      title: "creative concept title",
      objective: "what this video should achieve",
      hook: "first-line hook",
      cta: "soft ecommerce CTA without invented promo",
      scenes: [{
        scene: 1,
        durationSeconds: 7,
        purpose: "hook / proof / payoff / CTA",
        visual: "specific visual action for a vertical creator video",
        camera: "shot size, camera movement, framing",
        voiceover: "spoken Indonesian line",
        onScreenText: "short overlay text",
        evidenceUsed: ["fact grounded in Product DNA"],
        guardrail: "what not to claim or imply",
      }],
      fullVoiceover: "joined natural voiceover",
      caption: "short ecommerce social caption",
      hashtags: ["#relevant"],
      evidenceSummary: ["facts actually used by the script"],
      cautions: ["claims intentionally avoided"],
    }),
    "The sum of scene durationSeconds should be close to the target duration. Do not include markdown fences.",
  ].join("\n");
}

function normalizeScene(value: unknown, index: number): UgcStoryboardScene {
  const row = asRecord(value);
  const duration = Number(row.durationSeconds);
  return {
    scene: index + 1,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.min(20, Math.max(1, Math.round(duration))) : 5,
    purpose: asString(row.purpose, "Scene progression"),
    visual: asString(row.visual, "Tampilkan produk secara natural dalam frame vertikal."),
    camera: asString(row.camera, "Vertical medium shot, handheld natural."),
    voiceover: asString(row.voiceover),
    onScreenText: asString(row.onScreenText),
    evidenceUsed: asStringArray(row.evidenceUsed),
    guardrail: asString(row.guardrail, "Jangan menambahkan klaim yang tidak didukung Product DNA."),
  };
}

function normalizeStoryboard(raw: Record<string, unknown>, input: GenerateInput, model: string): UgcStoryboard {
  const expectedScenes = sceneCountForDuration(input.durationSeconds);
  const rawScenes = Array.isArray(raw.scenes) ? raw.scenes.slice(0, expectedScenes) : [];
  if (rawScenes.length !== expectedScenes) {
    throw providerError("UGC_STORYBOARD_SCENE_COUNT_INVALID", 502, "UGC_STORYBOARD_SCENE_COUNT_INVALID");
  }

  const dna = input.dnaProfile;
  const sourceAssets = Array.isArray(dna.sourceAssets) ? dna.sourceAssets : [];
  const sourceAssetIds = sourceAssets
    .map((item) => asString(asRecord(item).id))
    .filter(Boolean)
    .slice(0, 12);

  const scenes = rawScenes.map(normalizeScene);
  const generatedVoiceover = scenes.map((scene) => scene.voiceover).filter(Boolean).join(" ");

  return {
    title: asString(raw.title, `${input.productName} UGC Concept`),
    platform: input.platform,
    durationSeconds: input.durationSeconds,
    tone: input.tone,
    creativeAngle: input.creativeAngle || "natural product discovery",
    objective: asString(raw.objective, "Membuat video UGC yang relevan dan berbasis bukti produk."),
    hook: asString(raw.hook),
    cta: asString(raw.cta),
    scenes,
    fullVoiceover: asString(raw.fullVoiceover, generatedVoiceover),
    caption: asString(raw.caption),
    hashtags: asStringArray(raw.hashtags).slice(0, 10),
    evidenceSummary: asStringArray(raw.evidenceSummary),
    cautions: asStringArray(raw.cautions).length ? asStringArray(raw.cautions) : asStringArray(dna.cautions),
    generatedAt: new Date().toISOString(),
    model: `google-direct/${model}`,
    dnaLineage: {
      generatedAt: asString(dna.generatedAt) || null,
      model: asString(dna.model) || null,
      sourceAssetIds,
    },
  };
}

export async function generateUgcStoryboard(input: GenerateInput): Promise<UgcStoryboard> {
  const apiKey = readApiKey();
  if (!apiKey) throw providerError("GEMINI_API_KEY_UNAVAILABLE", 503, "GEMINI_API_KEY_UNAVAILABLE");

  const model = process.env.UGC_STORYBOARD_GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 3600,
          temperature: 0.45,
        },
      }),
      signal: AbortSignal.timeout(50_000),
    },
  );

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const nestedError = asRecord(payload?.error);
    const message = asString(nestedError.message, `Gemini storyboard request failed with HTTP ${response.status}`);
    const code = asString(nestedError.status, "GEMINI_STORYBOARD_ERROR");
    throw providerError(message, response.status, code);
  }

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map((part) => asString(asRecord(part).text)).filter(Boolean).join("\n").trim();
  if (!text) throw providerError("UGC_STORYBOARD_EMPTY_RESPONSE", 502, "UGC_STORYBOARD_EMPTY_RESPONSE");

  return normalizeStoryboard(parseJsonObject(text), input, model);
}
