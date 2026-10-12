import OpenAI from "openai";

export type ProductDnaSourceAsset = {
  id: string;
  assetType: string;
  mimeType: string;
  originalFilename: string | null;
  checksumSha256: string | null;
  bytes: Buffer;
};

export type ProductDnaProfile = {
  summary: string;
  category: string;
  positioning: string;
  targetAudience: string[];
  sellingPoints: string[];
  visualIdentity: {
    colors: string[];
    packaging: string;
    texture: string;
    shape: string;
  };
  observedClaims: string[];
  inferredOpportunities: string[];
  cautions: string[];
  sourceAssets: Array<{
    id: string;
    assetType: string;
    originalFilename: string | null;
    checksumSha256: string | null;
  }>;
  generatedAt: string;
  model: string;
};

const DEFAULT_MODEL = "google/gemini-3.5-flash-lite";

function readGatewayToken() {
  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_UNAVAILABLE");
  return token;
}

function stringValue(value: unknown, fallback = "Belum dapat disimpulkan dari source asset.") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PRODUCT_DNA_INVALID_RESPONSE");
  return parsed as Record<string, unknown>;
}

function normalizeProfile(raw: Record<string, unknown>, assets: ProductDnaSourceAsset[], model: string): ProductDnaProfile {
  const visual = raw.visualIdentity && typeof raw.visualIdentity === "object" && !Array.isArray(raw.visualIdentity)
    ? raw.visualIdentity as Record<string, unknown>
    : {};

  return {
    summary: stringValue(raw.summary),
    category: stringValue(raw.category, "Unclassified"),
    positioning: stringValue(raw.positioning),
    targetAudience: stringArray(raw.targetAudience),
    sellingPoints: stringArray(raw.sellingPoints),
    visualIdentity: {
      colors: stringArray(visual.colors),
      packaging: stringValue(visual.packaging),
      texture: stringValue(visual.texture),
      shape: stringValue(visual.shape),
    },
    observedClaims: stringArray(raw.observedClaims),
    inferredOpportunities: stringArray(raw.inferredOpportunities),
    cautions: stringArray(raw.cautions),
    sourceAssets: assets.map((asset) => ({
      id: asset.id,
      assetType: asset.assetType,
      originalFilename: asset.originalFilename,
      checksumSha256: asset.checksumSha256,
    })),
    generatedAt: new Date().toISOString(),
    model,
  };
}

export async function generateProductDna(input: {
  name: string;
  description: string | null;
  assets: ProductDnaSourceAsset[];
}): Promise<ProductDnaProfile> {
  if (input.assets.length === 0) throw new Error("PRODUCT_DNA_ASSETS_REQUIRED");

  const model = process.env.PRODUCT_DNA_MODEL?.trim() || DEFAULT_MODEL;
  const client = new OpenAI({
    apiKey: readGatewayToken(),
    baseURL: "https://ai-gateway.vercel.sh/v1",
  });

  const sourceLegend = input.assets
    .map((asset, index) => `Image ${index + 1}: ${asset.assetType}${asset.originalFilename ? ` (${asset.originalFilename})` : ""}`)
    .join("\n");

  const prompt = [
    "You are profiling a real ecommerce product from authoritative source images.",
    "Product Accuracy Lock: treat the attached images as source evidence. Never invent packaging text, ingredients, certifications, weight, flavor, brand claims, medical claims, halal claims, expiry dates, or guarantees that are not clearly visible or supplied in the product description.",
    "Separate facts visible in the source assets from marketing opportunities that are merely inferred.",
    "Return ONLY valid JSON. Do not use markdown fences.",
    "Use Indonesian for all descriptive values.",
    "Required JSON shape:",
    JSON.stringify({
      summary: "short product profile",
      category: "product category",
      positioning: "recommended positioning grounded in evidence",
      targetAudience: ["audience"],
      sellingPoints: ["evidence-grounded selling point"],
      visualIdentity: {
        colors: ["dominant color"],
        packaging: "packaging description",
        texture: "visible product texture",
        shape: "visible product shape/form",
      },
      observedClaims: ["only claims/text visibly supported by image or supplied description"],
      inferredOpportunities: ["clearly framed opportunity, not factual claim"],
      cautions: ["uncertain or unreadable information that should not be claimed"],
    }),
    `Product name: ${input.name}`,
    `Product description supplied by operator: ${input.description || "(none)"}`,
    "Attached source map:",
    sourceLegend,
  ].join("\n");

  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; detail: "auto"; image_url: string }
  > = [{ type: "input_text", text: prompt }];

  for (const asset of input.assets) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${asset.mimeType};base64,${asset.bytes.toString("base64")}`,
    });
  }

  const response = await client.responses.create({
    model,
    input: [{ role: "user", content }],
    max_output_tokens: 1800,
  });

  if (!response.output_text?.trim()) throw new Error("PRODUCT_DNA_EMPTY_RESPONSE");
  return normalizeProfile(parseJsonObject(response.output_text), input.assets, model);
}
