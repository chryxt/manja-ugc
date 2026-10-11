import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConnectionOptions } from 'bullmq';
import { JobRepository } from './src/db/job-repository.js';
import { JobRPC } from './src/db/job-rpc.js';
import { OutboxRPC } from './src/db/outbox-rpc.js';
import { DomainJobRPC } from './src/domain/domain-job-rpc.js';
import { PostgresJobDomainResolver } from './src/domain/job-domain-resolver.js';
import { DomainPersistence } from './src/domain/persistence.js';
import { GeminiVideoAssetSource } from './src/providers/gemini/gemini-video-asset-source.js';
import { OpenAIAdapter } from './src/providers/openai/openai-adapter.js';
import { BullMQDispatchQueue } from './src/queue/bullmq-queue.js';
import { OutboxDispatcher } from './src/queue/dispatcher.js';
import { R2StorageAdapter } from './src/storage/r2-adapter.js';
import { E2EGeminiAdapter, E2ERemoteAssetSource, type E2EVideoMode } from './src/testing/e2e-mock-veo.js';
import { createBullMQWorker } from './src/worker/bullmq-worker.js';
import { createJobHandlers } from './src/worker/handlers/factory.js';
import { JobProcessor } from './src/worker/job-processor.js';

const REQUIRED_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'E2E_ACTOR_USER_ID',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'E2E_PRODUCT_DNA_MODEL',
  'E2E_UGC_SCRIPT_MODEL',
  'E2E_VEO_MODEL',
] as const;

function env(name: (typeof REQUIRED_ENV)[number]): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

for (const name of REQUIRED_ENV) env(name);

const videoMode = parseVideoMode(process.env.E2E_VIDEO_MODE ?? 'live');
const databaseUrl = env('DATABASE_URL');
const actorUserId = env('E2E_ACTOR_USER_ID');
const runId = randomUUID();
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45 * 60 * 1000);
const pollIntervalMs = Number(process.env.E2E_POLL_INTERVAL_MS ?? 2_000);
const initialCredits = Number(process.env.E2E_INITIAL_CREDITS ?? 2_000);

const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const r2 = new R2StorageAdapter({
  accountId: env('R2_ACCOUNT_ID'),
  accessKeyId: env('R2_ACCESS_KEY_ID'),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  bucket: env('R2_BUCKET'),
  endpoint: process.env.R2_ENDPOINT || undefined,
});
const liveGeminiAssets = new GeminiVideoAssetSource({ apiKey: env('GEMINI_API_KEY') });
const remoteAssets = new E2ERemoteAssetSource(videoMode, liveGeminiAssets);
const persistence = new DomainPersistence(pool, r2, remoteAssets);
const resolver = new PostgresJobDomainResolver(pool, r2, {
  productDnaModel: env('E2E_PRODUCT_DNA_MODEL'),
  ugcScriptModel: env('E2E_UGC_SCRIPT_MODEL'),
  veoModel: env('E2E_VEO_MODEL'),
  assetUrlTtlSeconds: 900,
});
const jobs = new JobRepository(pool);
const rpc = new JobRPC(pool);
const domainJobs = new DomainJobRPC(pool);
const openai = new OpenAIAdapter({ apiKey: env('OPENAI_API_KEY') });
const gemini = new E2EGeminiAdapter(videoMode, { apiKey: env('GEMINI_API_KEY') });
const handlers = createJobHandlers({
  jobs,
  inputs: resolver,
  persistence,
  openai,
  gemini,
  ugcVideo: { pollDelaySeconds: Number(process.env.E2E_VEO_POLL_DELAY_SECONDS ?? 20) },
});
const processor = new JobProcessor(jobs, rpc, {
  workerId: `e2e-worker-${runId}`,
  leaseTtlSeconds: Number(process.env.E2E_LEASE_TTL_SECONDS ?? 90),
  handlers,
});
const redisConnection = parseRedisUrl(env('REDIS_URL'));
const queue = new BullMQDispatchQueue({ connection: redisConnection });
const outbox = new OutboxRPC(pool);
const dispatcher = new OutboxDispatcher(outbox, queue, {
  dispatcherId: `e2e-dispatcher-${runId}`,
  batchSize: 20,
  leaseSeconds: 60,
  retryDelaySeconds: 5,
  maxAttempts: 10,
});
const worker = createBullMQWorker(processor, {
  connection: redisConnection,
  queueName: 'ugc-jobs',
  concurrency: 1,
  lockDurationMs: 120_000,
  stalledIntervalMs: 30_000,
  maxStalledCount: 1,
});

worker.on('failed', (job, error) => {
  console.error(`[e2e] BullMQ delivery failed id=${job?.id ?? 'unknown'} message=${sanitize(error.message)}`);
});

async function main(): Promise<void> {
  console.log(`[e2e] starting sandbox run ${runId} video_mode=${videoMode}`);
  await assertSandboxPrerequisites();

  const fixture = await createSandboxFixture();
  console.log(`[e2e] fixture workspace=${fixture.workspaceId} product=${fixture.productId} storyboard=${fixture.storyboardId}`);

  const productDnaJobId = await domainJobs.createAndReserve({
    workspaceId: fixture.workspaceId,
    jobType: 'product_dna',
    actorUserId,
    idempotencyKey: `e2e:${runId}:product-dna`,
    productId: fixture.productId,
  });
  console.log(`[e2e] product_dna queued job=${productDnaJobId}`);
  await driveUntilTerminal(productDnaJobId, 'product_dna');
  await assertProductDnaPersisted(fixture.productId, productDnaJobId);

  const ugcVideoJobId = await domainJobs.createAndReserve({
    workspaceId: fixture.workspaceId,
    jobType: 'ugc_video',
    actorUserId,
    idempotencyKey: `e2e:${runId}:ugc-video`,
    productId: fixture.productId,
    storyboardId: fixture.storyboardId,
  });
  console.log(`[e2e] ugc_video queued job=${ugcVideoJobId}`);
  await driveUntilTerminal(ugcVideoJobId, 'ugc_video');

  const video = await assertGeneratedVideoPersisted(ugcVideoJobId);
  await assertR2Readable(video.storage_key);
  await assertFinancialSettlement(fixture.workspaceId, [productDnaJobId, ugcVideoJobId]);

  console.log(`[e2e] PASS sandbox: Product DNA + UGC video (${videoMode}) + R2 + exact-once settlement`);
  console.log(`[e2e] retained fixture for inspection workspace=${fixture.workspaceId} generated_video=${video.id}`);
}

async function assertSandboxPrerequisites(): Promise<void> {
  const actor = await pool.query(`SELECT 1 FROM auth.users WHERE id = $1`, [actorUserId]);
  if (actor.rowCount !== 1) {
    throw new Error(`E2E_ACTOR_USER_ID ${actorUserId} does not exist in auth.users`);
  }

  const required = await pool.query<{ domain_rpc: string | null; wakeup_rpc: string | null }>(
    `SELECT
       to_regprocedure('private.create_domain_job_and_reserve_credits(uuid,text,uuid,text,uuid,uuid)')::text AS domain_rpc,
       to_regprocedure('private.schedule_job_wakeup(uuid,uuid,integer)')::text AS wakeup_rpc`,
  );
  if (!required.rows[0]?.domain_rpc || !required.rows[0]?.wakeup_rpc) {
    throw new Error('Sandbox database is missing migrations 13-14');
  }
}

async function createSandboxFixture(): Promise<{ workspaceId: string; productId: string; storyboardId: string }> {
  const workspaceId = randomUUID();
  const productId = randomUUID();
  const storyboardId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.workspaces(id,name,slug)
       VALUES($1,$2,$3)`,
      [workspaceId, `E2E Sandbox ${runId.slice(0, 8)}`, `e2e-${runId}`],
    );
    await client.query(
      `INSERT INTO public.workspace_members(workspace_id,user_id,role)
       VALUES($1,$2,'owner')`,
      [workspaceId, actorUserId],
    );
    await client.query(
      `INSERT INTO public.credit_accounts(workspace_id,balance,reserved_credits)
       VALUES($1,$2,0)`,
      [workspaceId, initialCredits],
    );
    await client.query(
      `INSERT INTO public.products(id,workspace_id,name,description)
       VALUES($1,$2,$3,$4)`,
      [
        productId,
        workspaceId,
        'MANJA E2E Sandbox Product',
        'A fresh crunchy snack product used only for live AI UGC sandbox validation.',
      ],
    );
    await client.query(
      `INSERT INTO public.storyboards(id,workspace_id,product_id,payload,script_content,visual_prompts,status)
       VALUES($1,$2,$3,'{}'::jsonb,NULL,$4::jsonb,'draft')`,
      [
        storyboardId,
        workspaceId,
        productId,
        JSON.stringify({
          format: 'vertical UGC ad',
          duration: 'short',
          visualStyle: 'clean product-forward social video',
          safety: 'no people, no trademarked third-party characters',
        }),
      ],
    );
    await client.query('COMMIT');
    return { workspaceId, productId, storyboardId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function driveUntilTerminal(jobId: string, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const dispatch = await dispatcher.dispatchOnce();
    if (dispatch.claimed > 0) {
      console.log(`[e2e] ${label} dispatch claimed=${dispatch.claimed} completed=${dispatch.completed} failed=${dispatch.failed}`);
    }

    const result = await pool.query<{
      status: string;
      current_step: string | null;
      error_code: string | null;
      error_message: string | null;
    }>(
      `SELECT status::text AS status,current_step,error_code,error_message
       FROM public.jobs WHERE id=$1`,
      [jobId],
    );
    if (result.rowCount !== 1) throw new Error(`Job ${jobId} disappeared`);
    const row = result.rows[0];
    const marker = `${row.status}:${row.current_step ?? ''}`;
    if (marker !== lastStatus) {
      console.log(`[e2e] ${label} state=${marker}`);
      lastStatus = marker;
    }

    if (row.status === 'completed') return;
    if (row.status === 'failed' || row.status === 'cancelled') {
      throw new Error(`${label} terminal=${row.status} code=${row.error_code ?? 'unknown'} message=${sanitize(row.error_message ?? '')}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`${label} exceeded E2E timeout ${timeoutMs}ms`);
}

async function assertProductDnaPersisted(productId: string, jobId: string): Promise<void> {
  const result = await pool.query<{ dna_profile: unknown; dna_source_job_id: string | null }>(
    `SELECT dna_profile,dna_source_job_id FROM public.products WHERE id=$1`,
    [productId],
  );
  if (result.rowCount !== 1 || result.rows[0].dna_profile == null || result.rows[0].dna_source_job_id !== jobId) {
    throw new Error('Product DNA was not durably persisted from the completed job');
  }
  console.log('[e2e] Product DNA persistence verified');
}

async function assertGeneratedVideoPersisted(jobId: string): Promise<{ id: string; storage_key: string }> {
  const result = await pool.query<{ id: string; storage_key: string }>(
    `SELECT id,storage_key FROM public.generated_videos WHERE job_id=$1 ORDER BY created_at`,
    [jobId],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Expected exactly one generated_videos row for ${jobId}, got ${result.rowCount}`);
  }
  console.log(`[e2e] generated video persistence verified key=${result.rows[0].storage_key}`);
  return result.rows[0];
}

async function assertR2Readable(storageKey: string): Promise<void> {
  const signedUrl = await r2.generatePresignedUrl(storageKey, 300);
  const response = await fetch(signedUrl, { headers: { Range: 'bytes=0-0' } });
  if (!(response.status === 200 || response.status === 206)) {
    throw new Error(`R2 object verification failed with HTTP ${response.status}`);
  }
  await response.arrayBuffer();
  console.log('[e2e] R2 object read verified');
}

async function assertFinancialSettlement(workspaceId: string, jobIds: string[]): Promise<void> {
  const result = await pool.query<{
    id: string;
    status: string;
    cost_snapshot: number;
    reservation_status: string;
    deduct_count: number;
  }>(
    `SELECT j.id,j.status::text AS status,j.cost_snapshot,
            cr.status::text AS reservation_status,
            (SELECT count(*)::int FROM public.credit_transactions ct
              WHERE ct.job_id=j.id AND ct.transaction_type='JOB_DEDUCT') AS deduct_count
       FROM public.jobs j
       JOIN public.credit_reservations cr ON cr.job_id=j.id AND cr.workspace_id=j.workspace_id
      WHERE j.id = ANY($1::uuid[])
      ORDER BY j.id`,
    [jobIds],
  );
  if (result.rowCount !== jobIds.length) throw new Error('Missing job financial aggregate');
  for (const row of result.rows) {
    if (row.status !== 'completed' || row.reservation_status !== 'SETTLED' || Number(row.deduct_count) !== 1) {
      throw new Error(`Settlement invariant failed for job ${row.id}`);
    }
  }

  const expectedSpend = result.rows.reduce((sum, row) => sum + Number(row.cost_snapshot), 0);
  const account = await pool.query<{ balance: number; reserved_credits: number }>(
    `SELECT balance,reserved_credits FROM public.credit_accounts WHERE workspace_id=$1`,
    [workspaceId],
  );
  const balance = Number(account.rows[0].balance);
  const reserved = Number(account.rows[0].reserved_credits);
  if (balance !== initialCredits - expectedSpend || reserved !== 0) {
    throw new Error(`Credit account invariant failed: balance=${balance} reserved=${reserved} expectedBalance=${initialCredits - expectedSpend}`);
  }
  console.log(`[e2e] exact-once settlement verified spend=${expectedSpend} final_balance=${balance}`);
}

function parseVideoMode(raw: string): E2EVideoMode {
  if (raw === 'live' || raw === 'mock') return raw;
  throw new Error('E2E_VIDEO_MODE must be live or mock');
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
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
}

function sanitize(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(`[e2e] FAIL ${sanitize(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
