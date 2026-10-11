# ADR-0004: Gemini / Veo Provider Adapter

Status: Accepted

## Context

The platform already has a uniform provider contract and a worker policy that owns infrastructure retry. Gemini and Veo differ from OpenAI in two important ways:

1. The current `@google/genai` SDK exposes `AbortSignal`, but documents it as client-only cancellation. Aborting the client request does not guarantee service-side cancellation or avoidance of provider usage charges.
2. Veo video generation is represented as a long-running operation (LRO), while ordinary Gemini content generation is synchronous.

## Decision

- Use the official `@google/genai` SDK.
- Do not use the legacy `@google/generative-ai` package.
- Declare `externalIdempotency = false` for the Gemini adapter until Google documents a provider-side idempotency primitive for the relevant operation.
- Do not invent an idempotency header or metadata field.
- Declare `cancellation = 'none'` for the adapter because the current SDK surface used by this service does not expose a verified remote-cancel primitive for Veo LROs.
- Still propagate `AbortSignal` into request configuration to stop stale worker-side network activity quickly. This is only a local transport control and must not be described as service-side cancellation.
- Treat standard Gemini content generation as synchronous.
- Treat Veo generation as asynchronous. Persist the returned LRO `operation.name` as `providerOperationId` and recover status with `operations.getVideosOperation()`.
- Reconstruct the LRO handle from the persisted provider operation name when polling after worker restart.
- Keep BullMQ as the sole infrastructure retry authority. No provider adapter may create a new paid DB retry lineage entry.
- Safety / recitation / prohibited-content finish reasons are permanent provider outcomes, not infrastructure retries.
- 401/403 are provider operational incidents (`FATAL_P0`).
- 408/409/425/429 and 5xx are transient and consume the bounded BullMQ retry budget.

## Consequences

There remains an unavoidable ambiguity window for synchronous Gemini requests because the provider does not expose a verified external idempotency primitive for this path. PostgreSQL execution leases and operation fencing minimize concurrent duplicate execution, but cannot mathematically deduplicate a request that the provider accepted before the client lost the response.

For Veo, persistence of `operation.name` allows a restarted worker to poll the same remote operation rather than submit a new one after successful LRO creation has been recorded.

Provider capability flags are intentionally conservative and may only be upgraded after verification against current official Google API/SDK documentation.
