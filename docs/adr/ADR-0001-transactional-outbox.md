# ADR-0001: Transactional Outbox for Reliable Job Dispatch

Status: Proposed

## Context

The platform uses PostgreSQL as the authoritative source of truth for job state, billing, retry lineage, settlement, and audit. BullMQ/Redis is an execution transport only.

Creating a database job and then calling `queue.add()` creates a dual-write gap: PostgreSQL may commit while Redis enqueue fails. The result is a queued database job that is never delivered (a ghost job).

## Decision

Use a PostgreSQL transactional outbox as the reliability boundary between database commit and BullMQ dispatch.

### Queue payload

BullMQ carries only authoritative pointers:

```json
{
  "jobId": "uuid"
}
```

Optional `traceId` / `correlationId` may be included for observability only. They are never authoritative for billing, actor identity, lineage, or job state.

### Outbox row

Introduce a `job_dispatch_outbox` table with one logical dispatch record per job generation.

Recommended fields:

- `id uuid primary key`
- `workspace_id uuid not null`
- `job_id uuid not null`
- `dispatch_kind text not null default 'JOB_EXECUTE'`
- `status text not null` with `PENDING`, `DISPATCHING`, `DISPATCHED`, `DEAD`
- `attempt_count integer not null default 0`
- `available_at timestamptz not null default now()`
- `claimed_by text null`
- `claim_token uuid null`
- `claim_expires_at timestamptz null`
- `last_error_code text null`
- `last_error_message text null`
- `dispatched_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Physical invariants:

- composite FK `(job_id, workspace_id) -> jobs(id, workspace_id)`
- at most one active dispatch row per logical job delivery identity
- terminal `DISPATCHED` rows are immutable except metadata that does not affect semantics

### Atomic creation

A job that must be dispatched is inserted into the outbox in the same PostgreSQL transaction that creates the authoritative job/reservation state.

The application must never rely on:

1. commit database transaction;
2. call Redis;
3. hope both succeeded.

The outbox row is the durable evidence that queue delivery still needs to occur.

### Dispatcher / sweeper

A dispatcher process periodically claims eligible rows using PostgreSQL row locking, for example `FOR UPDATE SKIP LOCKED`.

Claim order:

1. select `PENDING` rows where `available_at <= now()`;
2. atomically mark them `DISPATCHING` with a short claim lease and increment `attempt_count`;
3. commit;
4. call BullMQ `queue.add()` using deterministic queue job identity derived from the database job id;
5. on success, mark the outbox row `DISPATCHED`;
6. on failure, return it to `PENDING` with exponential backoff, or move it to `DEAD` after an operational threshold.

The dispatcher claim is orchestration metadata, not financial state.

### Deterministic BullMQ identity

Use the database `jobId` as the BullMQ job identity where practical. Duplicate queue inserts are treated as transport-level idempotency only.

BullMQ deduplication must never be treated as the authoritative exactly-once mechanism. PostgreSQL state machines, execution leases, operation idempotency, and provider idempotency remain the safety layers.

### Recovery guarantees

If Redis is unavailable after the database commit:

- the outbox row remains `PENDING`;
- the sweeper retries later;
- the job cannot become permanently invisible solely because of the Redis outage.

If the dispatcher crashes after BullMQ accepts the message but before the database row is marked `DISPATCHED`:

- the outbox row becomes claimable again after lease expiry;
- a repeated `queue.add()` may occur;
- duplicate delivery is safe because the queue carries only `jobId`, the worker must acquire the PostgreSQL execution lease, and job/operation RPCs remain authoritative.

This is an at-least-once dispatch design with application-level idempotency, not a claim of distributed exactly-once delivery.

## BullMQ retry policy boundary

BullMQ retries are infrastructure retries of the same authoritative database job.

They must never call `private.retry_job()` automatically. `private.retry_job()` creates a new billed job entity and is a product/business action, not a queue transport retry.

Retryable infrastructure failures may include:

- Redis delivery interruption;
- transient worker process failure;
- transient provider/network errors when provider-side idempotency is available;
- temporary database connection failures.

Permanent/domain failures should be written to the database through the existing terminal RPCs and should not loop indefinitely in BullMQ.

## Sweeper responsibilities

The sweeper has two independent duties:

1. Redis dispatch recovery: reclaim stale `DISPATCHING` outbox rows and retry delivery.
2. Execution recovery: inspect expired PostgreSQL execution leases and hand eligible non-terminal jobs back to orchestration logic.

It must not infer financial corrections directly. Settlement/release remains exclusively behind private database RPCs.

## Ordering with the remaining BullMQ foundation

Implementation order:

1. transactional outbox schema + claim/complete/fail RPCs;
2. dispatcher/sweeper service;
3. queue connection and typed `{ jobId }` payload;
4. BullMQ worker retry/backoff/concurrency policy;
5. provider adapters with `operationId` mapped to provider idempotency keys where supported.

## Consequences

Benefits:

- eliminates the PostgreSQL-commit / Redis-enqueue ghost-job gap;
- preserves Thin Queue / Thick Database boundaries;
- tolerates dispatcher crashes and duplicate delivery;
- provides operational visibility for undelivered jobs.

Costs:

- one additional durable table and dispatcher process;
- at-least-once delivery semantics require duplicate-safe consumers;
- outbox retention/cleanup policy is required.
