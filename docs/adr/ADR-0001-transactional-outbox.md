# ADR-0001: Transactional Outbox for Reliable Job Dispatch

Status: Accepted

## Context

The platform uses PostgreSQL as the authoritative source of truth for job state, billing, retry lineage, settlement, and audit. BullMQ/Redis is an execution transport only.

Creating a database job and then calling `queue.add()` creates a dual-write gap: PostgreSQL may commit while Redis enqueue fails. The result is a queued database job that is never delivered (a ghost job).

## Decision

Use a PostgreSQL transactional outbox as the reliability boundary between database commit and BullMQ dispatch.

### Queue payload

BullMQ carries only:

```json
{ "jobId": "uuid" }
```

No pricing, billing state, actor identity, retry lineage, or lifecycle authority is stored in Redis.

### Outbox row

`public.job_dispatch_outbox` stores one durable dispatch record per job and uses:

- `pending`
- `processing`
- `completed`
- `failed`

A processing row carries `claim_token`, `claimed_by`, and `lease_expires_at`. Completion and failure RPCs require the claim token, preventing a stale dispatcher from acknowledging work after another dispatcher has recovered the expired lease.

Physical invariants include:

- composite FK `(job_id, workspace_id) -> jobs(id, workspace_id)`
- one outbox row per job
- payload must contain `jobId`
- processing rows must carry a valid claim tuple
- completed rows must carry `completed_at`
- FK delete action is `RESTRICT` to preserve dispatch history

### Atomic creation

A trigger on queued `jobs` inserts the outbox row in the same PostgreSQL transaction. `create_job_and_reserve_credits()` and `retry_job()` therefore cannot commit a new queued job without also persisting dispatch intent.

### Dispatcher / sweeper

`private.claim_outbox_messages()` uses `FOR UPDATE SKIP LOCKED` and may claim:

1. ready `pending` rows; or
2. `processing` rows whose dispatch lease has expired.

Claiming generates a fresh `claim_token`, records `claimed_by`, increments `attempt_count`, and sets a short lease expiry.

The dispatcher then:

1. calls BullMQ `Queue.add()`;
2. marks the row completed only after Redis accepts the enqueue;
3. on failure, returns the row to pending with delay or marks it failed after the attempt cap.

### Deterministic BullMQ identity

Use database `jobId` as the BullMQ job ID. Repeated outbox deliveries therefore converge on one transport identity where BullMQ deduplication applies.

BullMQ deduplication is only an optimization. PostgreSQL state machines, execution leases, operation idempotency, and provider idempotency remain the safety layers.

### Delivery semantics

This design is **at-least-once**, not distributed exactly-once.

If Redis accepts an enqueue but the dispatcher crashes before `complete_outbox_message()`, the outbox lease eventually expires and the message may be added again. This is acceptable because:

- queue payload is only `{ jobId }`;
- worker execution requires the PostgreSQL execution lease;
- job/operation RPCs remain authoritative;
- provider adapters will use provider-side idempotency where supported.

## BullMQ retry policy boundary

BullMQ retries are infrastructure retries of the same authoritative database job.

They must never call `private.retry_job()` automatically. `private.retry_job()` creates a new billed business job and remains an explicit product action.

## Sweeper responsibilities

The sweeper has two independent duties:

1. recover pending/stale outbox dispatch;
2. recover expired execution leases for eligible non-terminal jobs.

It must not make direct financial corrections. Settlement and release remain behind private database RPCs.

## Security

Do not issue schema-wide `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private`, because that can accidentally revoke existing RLS helpers and frozen RPC grants. New outbox RPCs are revoked and granted individually.

## Implementation order

1. transactional outbox schema + claim/complete/fail RPCs;
2. typed `OutboxRPC` gateway;
3. dispatcher service;
4. BullMQ adapter with deterministic `jobId`;
5. worker retry/backoff/concurrency policy;
6. provider adapters with external idempotency keys where supported.

## Consequences

Benefits:

- closes the PostgreSQL-commit / Redis-enqueue ghost-job gap;
- supports horizontal dispatchers with `SKIP LOCKED`;
- survives dispatcher crashes through claim-lease recovery;
- protects acknowledgements with claim-token fencing;
- preserves Thin Queue / Thick Database boundaries.

Costs:

- one durable outbox table and dispatcher process;
- at-least-once semantics require duplicate-safe consumers;
- failed-message escalation and retention cleanup policies are required.
