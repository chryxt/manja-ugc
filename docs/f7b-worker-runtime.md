# F7B Production Worker Runtime

This service is a long-running Node.js process. Do not run it as a request-scoped serverless function.

## Build and start

Bare Node host:

```bash
npm install --no-audit --no-fund
npm run worker:build
npm run worker:start
```

Docker:

```bash
docker build -f Dockerfile.worker -t manja-ugc-worker .
docker run --env-file .env.worker -p 8080:8080 manja-ugc-worker
```

## Health contract

- `GET /healthz` — process liveness. Returns 503 during shutdown.
- `GET /readyz` — database readiness plus last outbox dispatch summary/error.

The health payload never includes provider keys, database URLs, Redis credentials, or R2 credentials.

## Required secrets

See `.env.worker.example` for the complete contract. Minimum required values:

- `DATABASE_URL` — direct PostgreSQL connection to the MANJA UGC Supabase database.
- `REDIS_URL` — BullMQ-compatible Redis URL (`rediss://` recommended).
- `OPENAI_API_KEY` — used by the existing UGC video handler prompt/script path.
- `GEMINI_API_KEY` — Gemini/Veo submit, poll, and asset download.
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

All credentials are server-only. Never expose them through Next.js `NEXT_PUBLIC_*` variables.

## Runtime behavior

One process runs both pieces of the durable pipeline:

1. `OutboxDispatcher` claims pending PostgreSQL outbox rows and enqueues BullMQ deliveries whose payload remains exactly `{jobId}`.
2. The BullMQ consumer calls `JobProcessor`, which acquires the PostgreSQL execution lease and runs the existing Product DNA / UGC video handlers.

PostgreSQL remains authoritative for lifecycle, execution fencing, provider continuation state, credit reservation/settlement, domain bindings, generated media metadata, and audit history.

Multiple worker replicas are allowed. Database outbox claims and job execution leases prevent duplicate authoritative execution. Start with `WORKER_CONCURRENCY=1` until real provider quota is known.

## Graceful shutdown

`SIGTERM` and `SIGINT` stop new dispatcher ticks, stop accepting health connections, close the BullMQ worker/queue, and close the PostgreSQL pool. A bounded `WORKER_SHUTDOWN_TIMEOUT_MS` prevents a deployment from hanging forever.

## Deployment requirements

Use a platform that provides an always-running container/process and does not require an incoming HTTP request to keep the worker alive. Configure:

- Dockerfile: `Dockerfile.worker`
- Container port: `8080` (or set `PORT`)
- Health path: `/healthz`
- Recommended replicas initially: `1`
- Restart policy: always/on-failure

After deployment, the existing F7 job can be observed with:

```sql
select id, status, current_step, progress, error_code, error_message, updated_at
from public.jobs
where id = 'ed5c49c5-a6b3-4eff-84bc-cacea47c65d1';
```

The corresponding outbox row should transition away from `pending` once the dispatcher is alive. A provider quota error is only meaningful after the job has advanced beyond the untouched `queued` state.
