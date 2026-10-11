# ADR-0002: BullMQ Worker Reliability Policy

Status: Accepted

## Context

BullMQ is an execution transport. PostgreSQL remains authoritative for job lifecycle, billing, retry lineage, settlement, audit, execution leases, and operation identity.

A worker must tolerate duplicate delivery, process crashes, provider/network ambiguity, and Redis stalls without turning infrastructure retries into new paid jobs.

## Decision

### Queue payload

Workers receive only:

```json
{ "jobId": "uuid" }
```

### Execution ownership

Before work begins, a worker acquires the PostgreSQL execution lease. A heartbeat renews the lease while work is active. Provider-spend paths must assert the lease immediately before external side effects.

BullMQ's Redis lock is delivery coordination only. It is not the provider-spend authority.

### Retry boundary

BullMQ retries are bounded infrastructure retries of the same authoritative database job.

Default transport budget:

- attempts: 5
- exponential backoff starting at 5 seconds

BullMQ retry must never call `private.retry_job()`. That RPC creates a new billed business job and requires explicit product/user intent.

### Error dispositions

Worker errors are classified into three outcomes:

1. `retry`
   - transient provider/network failures
   - HTTP 408/409/425/429/5xx
   - transient PostgreSQL connectivity/serialization/deadlock errors
   - execution-claim contention

2. `terminal-failure`
   - permanent provider/domain failures such as invalid input, missing assets, unsupported job type, or policy rejection
   - worker calls `finalize_job(..., 'failed')` once, then raises BullMQ `UnrecoverableError`

3. `operational-stop`
   - financial invariants
   - missing authoritative job state
   - unsafe state-machine conflicts
   - worker does not invent compensating financial mutations; processing stops and the incident is escalated operationally

### Retry exhaustion

If a worker owns the PostgreSQL execution lease and the final BullMQ infrastructure attempt fails, the worker terminalizes the same DB job as `failed` with `INFRA_RETRY_EXHAUSTED`, releasing the existing reservation through the authoritative DB RPC.

If the worker never acquired the execution lease, retry exhaustion must not terminalize a job another worker may actively own.

### Concurrency and rate limiting

Worker defaults are conservative and configurable:

- concurrency: 4
- BullMQ lock duration: 60 seconds
- stalled check: 30 seconds
- max stalled count: 1
- optional provider/API rate limiter

Provider-specific limits may override these settings without changing job/billing semantics.

### Heartbeat and cancellation

The DB execution lease heartbeat runs independently of BullMQ lock renewal. Heartbeat failure aborts the execution signal exposed to handlers/provider adapters.

Handlers must support cancellation/abort where the provider permits it and must re-check authoritative state/lease before each expensive provider operation.

### Financial boundary

Handlers never mutate credit balances, reservations, retry lineage, or terminal financial state directly. Completion/failure settlement goes exclusively through private DB RPCs.

### External idempotency

Provider adapters should map `job_operations.id` to provider idempotency keys where supported. This is the last-mile defense for ambiguous network outcomes after a request may have reached an external provider but before its response reaches the worker.

## Consequences

- duplicate Redis delivery is safe behind DB execution fencing;
- zombie workers are fenced by PostgreSQL leases;
- infrastructure retry does not create duplicate billing lineage;
- permanent failures release reservations deterministically through DB settlement;
- invariant incidents remain visible rather than being hidden by worker-side compensation.
