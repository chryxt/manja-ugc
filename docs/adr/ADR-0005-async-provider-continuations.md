# ADR-0005: Async Provider Continuations

Status: Accepted

## Context

Long-running provider work such as Veo must not hold a BullMQ worker or PostgreSQL execution lease for the full provider runtime. A worker may also crash after an external provider accepted a request but before the local database recorded the result.

## Decision

1. Worker handlers are re-entrant and return either `completed` or `deferred`.
2. Async provider submission is persisted in `job_operations` as `submitted`; submission success is not treated as operation success.
3. `provider_operation_id` is recorded before the worker releases its execution lease.
4. A durable database wakeup is scheduled through `job_dispatch_outbox.available_at`; no in-process polling loop is used.
5. Queue payload remains exactly `{ jobId }`.
6. BullMQ internal delivery identity is `outbox_id:attempt_count`, not database `jobId`, so one DB job can have multiple legitimate continuation deliveries while repeated dispatch of one outbox claim remains traceable.
7. `resume_or_start_job_operation` reuses an existing non-terminal operation UUID. This preserves the same provider idempotency key after worker crashes during an ambiguous synchronous request only for providers that officially support external idempotency (currently OpenAI). Providers without verified external idempotency are not blindly resubmitted after an ambiguous crash.
8. Provider polling reads the persisted `provider_operation_id`. If still non-terminal, the same wakeup row is re-armed with a later `available_at`.
9. Duplicate wakeups are safe because execution leases fence workers and handlers inspect authoritative `job_operations` before any provider side effect.
10. Terminal financial settlement remains centralized in `JobProcessor` via `private.finalize_job`.
11. Completed provider media is persisted to platform-owned object storage before the provider operation is marked succeeded. If transfer fails, the operation stays non-terminal and the same provider result can be recovered again.
12. Object-storage upload is stream-based. The worker lease heartbeat remains active during provider-download -> R2 upload, and the worker asserts its lease before and after the transfer.

## Veo lifecycle

`processing -> waiting_provider -> deferred -> wakeup -> poll -> ... -> provider completed -> persist video to R2 -> provider operation succeeded -> job completed`

A successful Veo submission only means Google accepted an LRO. It does not settle credits and does not mark the provider operation `succeeded`.

## Failure semantics

- transient poll/transport/storage errors use the bounded BullMQ infrastructure retry budget;
- terminal provider failures finalize the existing provider operation as failed and flow through Worker Policy;
- invariant/financial errors remain operational incidents and are never compensated with guessed mutations;
- client-side abort is not assumed to cancel Google server-side execution;
- Gemini synchronous operations without verified external idempotency stop for operator reconciliation when recovered in an ambiguous non-terminal state;
- R2 persistence uses deterministic object keys and idempotent database upserts so crash recovery can repeat the transfer safely.

## Consequences

Workers stay short-lived and stateless, provider LRO state remains recoverable after crashes, delayed polling does not depend on an in-memory timer or Redis-only scheduler state, and completed provider media is moved into platform-controlled storage before financial settlement.
