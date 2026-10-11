# ADR-0003: AI Provider Adapter Contract v1

Status: Accepted

## Context

Workers must not contain provider-specific HTTP semantics, retry rules, authentication interpretation, or error dictionaries. PostgreSQL remains authoritative for job/operation state, execution leases, billing, and audit; BullMQ owns bounded infrastructure retry orchestration.

Provider integrations need a uniform boundary for OpenAI, Gemini/Veo, FFmpeg/internal tools, and future providers.

## Decision

All external execution providers implement `IAIProviderAdapter` from `src/providers/types.ts`.

The contract exposes:

- `submit(operationId, operationType, payload, context, abortSignal)`
- `getStatus(providerOperationId, operationType, abortSignal)`
- optional `cancel(...)`
- declared capabilities for external idempotency, async status, and cancellation support
- normalized provider errors using `TRANSIENT`, `PERMANENT`, and `FATAL_P0`

## Operation identity

`public.job_operations.id` is the canonical external execution identity.

When a provider officially supports an idempotency primitive, the adapter MUST bind `operationId` to that primitive. It must not invent unsupported headers or parameters.

For OpenAI, the official Node SDK request options expose `idempotencyKey`; `OpenAIAdapter.submit()` binds `operationId` to that option.

Provider idempotency is last-mile protection against ambiguous network outcomes. It does not replace PostgreSQL execution leases or operation idempotency.

## Retry ownership

Provider SDK automatic retries are disabled where possible.

For OpenAI, every request explicitly uses `maxRetries: 0`, and the client default is also configured with `maxRetries: 0`.

Retry ownership remains:

1. provider adapter normalizes the error;
2. Worker Policy classifies it;
3. BullMQ applies the bounded infrastructure retry budget to the same database job;
4. `private.retry_job()` is never invoked automatically.

This prevents nested retry loops and preserves observable attempt accounting.

## Cancellation / lease loss

Adapters accept `AbortSignal` and pass it to the provider transport when supported.

The worker lease heartbeat abort signal therefore propagates to in-flight provider HTTP requests. This limits zombie-worker activity after execution lease loss.

Provider-side cancellation is capability-specific. OpenAI Responses cancellation is treated as `background-only`; callers must not assume a synchronous response can be cancelled by provider operation ID.

## Error normalization

Adapter errors are represented as `ProviderExecutionError`:

- `TRANSIENT`: network/timeout, ordinary rate limiting, retryable conflicts, provider 5xx/overload;
- `PERMANENT`: invalid request/input or other non-retryable request-level failures;
- `FATAL_P0`: provider credential/account/billing conditions such as authentication/authorization failure or hard quota/account disablement.

`FATAL_P0` maps to Worker Policy `operational-stop`. The worker must not compensate financial state by guessing.

## OpenAI implementation

`src/providers/openai/openai-adapter.ts` uses the official OpenAI Node SDK and the Responses API.

Rules:

- Node.js runtime floor: 22+
- Responses API for submit/retrieve/cancel
- `operationId` -> OpenAI `idempotencyKey`
- `AbortSignal` propagated through SDK request options
- SDK retries disabled (`maxRetries: 0`)
- request IDs/status/model/usage normalized into adapter metadata
- background response IDs can be polled and cancelled

## Consequences

Benefits:

- worker code remains provider-agnostic;
- one retry authority instead of nested hidden retry loops;
- external idempotency is bound to durable DB operation identity;
- zombie workers can abort provider transport after lease loss;
- provider-specific failure semantics become observable and testable.

Costs:

- each provider requires an explicit normalization dictionary;
- provider capability differences remain visible rather than being hidden behind false abstractions;
- provider API/SDK upgrades require contract-level regression tests.
