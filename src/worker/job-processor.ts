import { UnrecoverableError } from 'bullmq';
import type { JobRecord, JobRepository } from '../db/job-repository';
import type { ExecutionLease, JobRPC } from '../db/job-rpc';
import { ExecutionContext } from './execution-context';
import { classifyWorkerError } from './error-policy';
import { LeaseHeartbeat } from './lease-heartbeat';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export type WorkerHandlerResult =
  | { kind: 'completed' }
  | { kind: 'deferred' };

export interface WorkerJobHandler {
  execute(
    context: ExecutionContext,
    job: JobRecord,
    signal: AbortSignal,
  ): Promise<WorkerHandlerResult>;
}

export interface JobProcessorOptions {
  workerId: string;
  leaseTtlSeconds?: number;
  handlers: Record<string, WorkerJobHandler>;
}

export interface RetryContext {
  isFinalAttempt: boolean;
}

export class JobProcessor {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rpc: JobRPC,
    private readonly options: JobProcessorOptions,
  ) {}

  async process(jobId: string, retry: RetryContext): Promise<void> {
    let job = await this.jobs.getById(jobId);
    if (TERMINAL_STATUSES.has(job.status)) return;

    const handler = this.options.handlers[job.jobType];
    if (!handler) {
      await this.terminalizeOrThrow(job, 'UNSUPPORTED_JOB_TYPE', `No worker handler for ${job.jobType}`);
      throw new UnrecoverableError(`Unsupported job type: ${job.jobType}`);
    }

    let lease: ExecutionLease | null = null;
    let heartbeat: LeaseHeartbeat | null = null;

    try {
      lease = await this.rpc.claimExecution(jobId, this.options.workerId, this.options.leaseTtlSeconds ?? 60);
      heartbeat = new LeaseHeartbeat(this.rpc, lease, { ttlSeconds: this.options.leaseTtlSeconds ?? 60 });
      heartbeat.start();

      job = await this.jobs.getById(jobId);
      if (TERMINAL_STATUSES.has(job.status)) return;

      if (job.status === 'queued') {
        await this.rpc.transitionJobState(jobId, 'processing', 'worker_claimed');
        job = await this.jobs.getById(jobId);
      }

      heartbeat.assertHealthy();
      const context = new ExecutionContext(this.rpc, lease);
      const result = await handler.execute(context, job, heartbeat.abortController.signal);
      heartbeat.assertHealthy();
      await context.assertLease();

      // Deferred handlers have durably scheduled their next wakeup and intentionally
      // leave the job non-terminal (typically waiting_provider). Release the worker lease.
      if (result.kind === 'deferred') return;

      const latest = await this.jobs.getById(jobId);
      if (!TERMINAL_STATUSES.has(latest.status)) {
        if (!latest.createdBy) {
          throw Object.assign(new Error('Job has no created_by actor for terminal audit'), {
            code: 'MISSING_JOB_ACTOR',
          });
        }
        await this.rpc.finalizeJob(jobId, 'completed', latest.createdBy);
      }
    } catch (error) {
      const decision = classifyWorkerError(error);

      if (decision.disposition === 'terminal-failure') {
        await this.terminalizeOrThrow(job, decision.code, decision.message);
        throw new UnrecoverableError(`${decision.code}: ${decision.message}`);
      }

      if (decision.disposition === 'operational-stop') {
        throw new UnrecoverableError(`${decision.code}: ${decision.message}`);
      }

      if (retry.isFinalAttempt && lease) {
        await this.terminalizeOrThrow(job, 'INFRA_RETRY_EXHAUSTED', decision.message);
        throw new UnrecoverableError(`INFRA_RETRY_EXHAUSTED: ${decision.message}`);
      }

      throw error;
    } finally {
      if (heartbeat) await heartbeat.stop();
      if (lease) {
        try {
          await this.rpc.releaseExecutionLease(lease);
        } catch {
          // Lease expiry/reclaim is the recovery path. Never mask the primary outcome.
        }
      }
    }
  }

  private async terminalizeOrThrow(job: JobRecord, code: string, message: string): Promise<void> {
    const latest = await this.jobs.getById(job.id);
    if (TERMINAL_STATUSES.has(latest.status)) return;

    if (!latest.createdBy) {
      throw new UnrecoverableError(`MISSING_JOB_ACTOR: cannot terminalize job ${job.id}`);
    }

    await this.rpc.finalizeJob(job.id, 'failed', latest.createdBy, code, message.slice(0, 2000));
  }
}
