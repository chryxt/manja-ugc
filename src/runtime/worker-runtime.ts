import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { ConnectionOptions } from 'bullmq';

import { JobRepository } from '../db/job-repository.js';
import { JobRPC } from '../db/job-rpc.js';
import { OutboxRPC } from '../db/outbox-rpc.js';
import { PostgresJobDomainResolver } from '../domain/job-domain-resolver.js';
import { DomainPersistence } from '../domain/persistence.js';
import { GeminiAdapter } from '../providers/gemini/gemini-adapter.js';
import { GeminiVideoAssetSource } from '../providers/gemini/gemini-video-asset-source.js';
import { OpenAIAdapter } from '../providers/openai/openai-adapter.js';
import { BullMQDispatchQueue } from '../queue/bullmq-queue.js';
import { OutboxDispatcher } from '../queue/dispatcher.js';
import { R2StorageAdapter } from '../storage/r2-adapter.js';
import { createBullMQWorker } from '../worker/bullmq-worker.js';
import { createJobHandlers } from '../worker/handlers/factory.js';
import { JobProcessor } from '../worker/job-processor.js';

const runtimeId = process.env.WORKER_ID?.trim() || `worker-${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();
let shuttingDown = false;
let dispatcherTimer: NodeJS.Timeout | null = null;
let dispatcherRunning = false;
let lastDispatchAt: string | null = null;
let lastDispatchError: string | null = null;
let lastDispatchSummary: { claimed: number; completed: number; failed: number } | null = null;

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
const redisConnection = parseRedisUrl(config.redisUrl);
const queue = new BullMQDispatchQueue({ connection: redisConnection });
const outbox = new OutboxRPC(pool);
const dispatcher = new OutboxDispatcher(outbox, queue, {
  dispatcherId: `${runtimeId}-dispatcher`,
  batchSize: config.dispatchBatchSize,
  leaseSeconds: config.dispatchLeaseSeconds,
  retryDelaySeconds: config.dispatchRetryDelaySeconds,
  maxAttempts: config.dispatchMaxAttempts,
});

const r2 = new R2StorageAdapter({
  accountId: config.r2AccountId,
  accessKeyId: config.r2AccessKeyId,
  secretAccessKey: config.r2SecretAccessKey,
  bucket: config.r2Bucket,
  endpoint: config.r2Endpoint,
});
const persistence = new DomainPersistence(
  pool,
  r2,
  new GeminiVideoAssetSource({ apiKey: config.geminiApiKey }),
);
const resolver = new PostgresJobDomainResolver(pool, r2, {
  productDnaModel: config.productDnaModel,
  ugcScriptModel: config.ugcScriptModel,
  veoModel: config.veoModel,
  assetUrlTtlSeconds: config.assetUrlTtlSeconds,
});
const jobs = new JobRepository(pool);
const rpc = new JobRPC(pool);
const openai = new OpenAIAdapter({ apiKey: config.openaiApiKey });
const gemini = new GeminiAdapter({ apiKey: config.geminiApiKey });
const handlers = createJobHandlers({
  jobs,
  inputs: resolver,
  persistence,
  openai,
  gemini,
  ugcVideo: { pollDelaySeconds: config.veoPollDelaySeconds },
});
const processor = new JobProcessor(jobs, rpc, {
  workerId: runtimeId,
  leaseTtlSeconds: config.leaseTtlSeconds,
  handlers,
});
const worker = createBullMQWorker(processor, {
  connection: redisConnection,
  queueName: config.queueName,
  concurrency: config.workerConcurrency,
  lockDurationMs: config.workerLockDurationMs,
  stalledIntervalMs: config.workerStalledIntervalMs,
  maxStalledCount: config.workerMaxStalledCount,
});

worker.on('ready', () => log('info', 'bullmq_worker_ready', { queue: config.queueName }));
worker.on('active', (job) => log('info', 'bullmq_job_active', { deliveryId: job.id, jobId: job.data?.jobId }));
worker.on('completed', (job) => log('info', 'bullmq_job_completed', { deliveryId: job.id, jobId: job.data?.jobId }));
worker.on('failed', (job, error) => log('error', 'bullmq_job_failed', {
  deliveryId: job?.id,
  jobId: job?.data?.jobId,
  error: sanitize(error.message),
}));
worker.on('error', (error) => log('error', 'bullmq_worker_error', { error: sanitize(error.message) }));

const healthServer = createServer(async (req, res) => {
  if (req.url === '/healthz') {
    const healthy = !shuttingDown;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: healthy, runtimeId, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
    return;
  }

  if (req.url === '/readyz') {
    try {
      await pool.query('select 1');
      res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: !shuttingDown,
        runtimeId,
        queue: config.queueName,
        lastDispatchAt,
        lastDispatchError,
        lastDispatchSummary,
      }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, runtimeId, error: sanitize(toError(error).message) }));
    }
    return;
  }

  res.writeHead(404).end();
});

async function dispatchTick(): Promise<void> {
  if (shuttingDown || dispatcherRunning) return;
  dispatcherRunning = true;
  try {
    const summary = await dispatcher.dispatchOnce();
    lastDispatchAt = new Date().toISOString();
    lastDispatchSummary = summary;
    lastDispatchError = null;
    if (summary.claimed > 0 || summary.failed > 0) {
      log(summary.failed > 0 ? 'warn' : 'info', 'outbox_dispatch', {
        claimed: summary.claimed,
        completed: summary.completed,
        failed: summary.failed,
      });
    }
  } catch (error) {
    lastDispatchAt = new Date().toISOString();
    lastDispatchError = sanitize(toError(error).message);
    log('error', 'outbox_dispatch_error', { error: lastDispatchError });
  } finally {
    dispatcherRunning = false;
  }
}

function scheduleDispatcher(): void {
  dispatcherTimer = setInterval(() => void dispatchTick(), config.dispatchIntervalMs);
  dispatcherTimer.unref?.();
  void dispatchTick();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
  if (dispatcherTimer) clearInterval(dispatcherTimer);

  const forceExit = setTimeout(() => {
    log('error', 'shutdown_timeout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref?.();

  try {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await worker.close();
    await queue.close();
    await pool.end();
    clearTimeout(forceExit);
    log('info', 'shutdown_completed', { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    log('error', 'shutdown_failed', { signal, error: sanitize(toError(error).message) });
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('uncaughtException', (error) => {
  log('error', 'uncaught_exception', { error: sanitize(error.message) });
  void shutdown('uncaughtException');
});
process.once('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { error: sanitize(toError(reason).message) });
  void shutdown('unhandledRejection');
});

healthServer.listen(config.port, config.host, () => {
  log('info', 'worker_runtime_started', {
    host: config.host,
    port: config.port,
    queue: config.queueName,
    concurrency: config.workerConcurrency,
    dispatchIntervalMs: config.dispatchIntervalMs,
    veoModel: config.veoModel,
  });
  scheduleDispatcher();
});

function loadConfig() {
  return {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    openaiApiKey: required('OPENAI_API_KEY'),
    geminiApiKey: required('GEMINI_API_KEY'),
    r2AccountId: required('R2_ACCOUNT_ID'),
    r2AccessKeyId: required('R2_ACCESS_KEY_ID'),
    r2SecretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    r2Bucket: required('R2_BUCKET'),
    r2Endpoint: optional('R2_ENDPOINT'),
    productDnaModel: optional('PRODUCT_DNA_MODEL') || 'gemini-3.5-flash-lite',
    ugcScriptModel: optional('UGC_SCRIPT_MODEL') || 'gpt-5-mini',
    veoModel: optional('VEO_MODEL') || 'veo-3.1-generate-preview',
    assetUrlTtlSeconds: int('ASSET_URL_TTL_SECONDS', 900, 60, 3600),
    veoPollDelaySeconds: int('VEO_POLL_DELAY_SECONDS', 20, 5, 300),
    queueName: optional('WORKER_QUEUE_NAME') || 'ugc-jobs',
    workerConcurrency: int('WORKER_CONCURRENCY', 1, 1, 32),
    workerLockDurationMs: int('WORKER_LOCK_DURATION_MS', 120_000, 30_000, 600_000),
    workerStalledIntervalMs: int('WORKER_STALLED_INTERVAL_MS', 30_000, 5_000, 300_000),
    workerMaxStalledCount: int('WORKER_MAX_STALLED_COUNT', 1, 0, 10),
    leaseTtlSeconds: int('WORKER_LEASE_TTL_SECONDS', 90, 30, 600),
    dispatchIntervalMs: int('OUTBOX_DISPATCH_INTERVAL_MS', 2_000, 250, 60_000),
    dispatchBatchSize: int('OUTBOX_DISPATCH_BATCH_SIZE', 20, 1, 200),
    dispatchLeaseSeconds: int('OUTBOX_DISPATCH_LEASE_SECONDS', 60, 10, 600),
    dispatchRetryDelaySeconds: int('OUTBOX_DISPATCH_RETRY_DELAY_SECONDS', 5, 1, 300),
    dispatchMaxAttempts: int('OUTBOX_DISPATCH_MAX_ATTEMPTS', 10, 1, 100),
    dbPoolMax: int('WORKER_DB_POOL_MAX', 10, 1, 50),
    shutdownTimeoutMs: int('WORKER_SHUTDOWN_TIMEOUT_MS', 30_000, 5_000, 120_000),
    host: optional('HOST') || '0.0.0.0',
    port: int('PORT', 8080, 1, 65535),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseRedisUrl(raw: string): ConnectionOptions {
  const url = new URL(raw);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
}

function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({ ts: new Date().toISOString(), level, event, runtimeId, ...fields });
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

function sanitize(value: string): string {
  return value
    .replace(/(api[_-]?key|authorization|bearer|password|secret|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-key]')
    .replace(/sk-[0-9A-Za-z_-]{16,}/g, '[redacted-key]')
    .slice(0, 1000);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
