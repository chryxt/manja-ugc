import type { Pool } from 'pg';
import { mapDatabaseError } from './errors';

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'waiting_provider'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobOperationStatus =
  | 'created'
  | 'submitted'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AIProvider = 'openai' | 'gemini' | 'ninerouter' | 'replicate' | 'ffmpeg' | 'internal';

export interface ExecutionLease {
  jobId: string;
  workerId: string;
  leaseToken: string;
}

export class JobRPC {
  constructor(private readonly pool: Pool) {}

  async transitionJobState(jobId: string, newStatus: JobStatus, newStep?: string): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.transition_job_state($1, $2, $3)`,
        [jobId, newStatus, newStep ?? null],
      );
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async startOperation(
    jobId: string,
    provider: AIProvider,
    operationKey: string,
    operationType: string,
    metadata?: unknown,
  ): Promise<string> {
    try {
      const result = await this.pool.query<{ operation_id: string }>(
        `SELECT private.resume_or_start_job_operation($1, $2, $3, $4, $5::jsonb) AS operation_id`,
        [jobId, provider, operationKey, operationType, metadata === undefined ? null : JSON.stringify(metadata)],
      );
      return result.rows[0].operation_id;
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async recordOperationSubmission(
    jobId: string,
    operationId: string,
    providerOperationId: string,
    responseMetadata?: unknown,
  ): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.record_job_operation_submission($1, $2, $3, $4::jsonb)`,
        [jobId, operationId, providerOperationId, responseMetadata === undefined ? null : JSON.stringify(responseMetadata)],
      );
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async scheduleJobWakeup(jobId: string, operationId: string, delaySeconds = 15): Promise<string> {
    try {
      const result = await this.pool.query<{ outbox_id: string }>(
        `SELECT private.schedule_job_wakeup($1, $2, $3) AS outbox_id`,
        [jobId, operationId, delaySeconds],
      );
      return result.rows[0].outbox_id;
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async finalizeOperation(
    jobId: string,
    operationId: string,
    outcome: Extract<JobOperationStatus, 'succeeded' | 'failed' | 'cancelled'>,
    providerOperationId?: string,
    responseMetadata?: unknown,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.finalize_job_operation($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [jobId, operationId, outcome, providerOperationId ?? null,
          responseMetadata === undefined ? null : JSON.stringify(responseMetadata),
          errorCode ?? null, errorMessage ?? null],
      );
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async finalizeJob(
    jobId: string,
    outcome: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>,
    actorId: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.finalize_job($1, $2, $3, $4, $5)`,
        [jobId, outcome, actorId, errorCode ?? null, errorMessage ?? null],
      );
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async claimExecution(jobId: string, workerId: string, ttlSeconds = 60): Promise<ExecutionLease> {
    try {
      const result = await this.pool.query<{ lease_token: string }>(
        `SELECT private.claim_job_execution($1, $2, $3) AS lease_token`,
        [jobId, workerId, ttlSeconds],
      );
      return { jobId, workerId, leaseToken: result.rows[0].lease_token };
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }

  async renewExecutionLease(lease: ExecutionLease, ttlSeconds = 60): Promise<Date> {
    try {
      const result = await this.pool.query<{ expires_at: Date }>(
        `SELECT private.renew_job_execution_lease($1, $2, $3, $4) AS expires_at`,
        [lease.jobId, lease.workerId, lease.leaseToken, ttlSeconds],
      );
      return result.rows[0].expires_at;
    } catch (error) {
      mapDatabaseError(error, lease.jobId);
    }
  }

  async assertExecutionLease(lease: ExecutionLease): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.assert_job_execution_lease($1, $2, $3)`,
        [lease.jobId, lease.workerId, lease.leaseToken],
      );
    } catch (error) {
      mapDatabaseError(error, lease.jobId);
    }
  }

  async releaseExecutionLease(lease: ExecutionLease): Promise<boolean> {
    try {
      const result = await this.pool.query<{ released: boolean }>(
        `SELECT private.release_job_execution_lease($1, $2, $3) AS released`,
        [lease.jobId, lease.workerId, lease.leaseToken],
      );
      return result.rows[0].released;
    } catch (error) {
      mapDatabaseError(error, lease.jobId);
    }
  }
}
