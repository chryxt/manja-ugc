import type { Pool } from 'pg';
import { JobNotFoundError, mapDatabaseError } from './errors';
import type { AIProvider, JobOperationStatus, JobStatus } from './job-rpc';

export interface JobRecord {
  id: string;
  workspaceId: string;
  jobType: string;
  status: JobStatus;
  currentStep: string | null;
  createdBy: string | null;
  parentJobId: string | null;
  rootJobId: string | null;
  attemptNumber: number;
  costSnapshot: number;
  pricingVersion: string;
}

export interface JobOperationRecord {
  id: string;
  jobId: string;
  workspaceId: string;
  provider: AIProvider;
  operationKey: string;
  operationType: string;
  providerOperationId: string | null;
  status: JobOperationStatus;
  attemptNumber: number;
  responseMetadata: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export class JobRepository {
  constructor(private readonly pool: Pool) {}

  async getById(jobId: string): Promise<JobRecord> {
    try {
      const result = await this.pool.query<{
        id: string;
        workspace_id: string;
        job_type: string;
        status: JobStatus;
        current_step: string | null;
        created_by: string | null;
        parent_job_id: string | null;
        root_job_id: string | null;
        attempt_number: number;
        cost_snapshot: number;
        pricing_version: string;
      }>(
        `SELECT
           id,
           workspace_id,
           job_type,
           status,
           current_step,
           created_by,
           parent_job_id,
           root_job_id,
           attempt_number,
           cost_snapshot,
           pricing_version
         FROM public.jobs
         WHERE id = $1`,
        [jobId],
      );

      if (result.rowCount !== 1) {
        throw new JobNotFoundError(jobId);
      }

      const row = result.rows[0];
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        jobType: row.job_type,
        status: row.status,
        currentStep: row.current_step,
        createdBy: row.created_by,
        parentJobId: row.parent_job_id,
        rootJobId: row.root_job_id,
        attemptNumber: Number(row.attempt_number),
        costSnapshot: Number(row.cost_snapshot),
        pricingVersion: row.pricing_version,
      };
    } catch (error) {
      if (error instanceof JobNotFoundError) throw error;
      mapDatabaseError(error, jobId);
    }
  }

  async getLatestOperation(jobId: string, operationKey: string): Promise<JobOperationRecord | null> {
    try {
      const result = await this.pool.query<{
        id: string;
        job_id: string;
        workspace_id: string;
        provider: AIProvider;
        operation_key: string;
        operation_type: string;
        provider_operation_id: string | null;
        status: JobOperationStatus;
        attempt_number: number;
        response_metadata: unknown;
        error_code: string | null;
        error_message: string | null;
      }>(
        `SELECT id, job_id, workspace_id, provider, operation_key, operation_type,
                provider_operation_id, status, attempt_number, response_metadata,
                error_code, error_message
         FROM public.job_operations
         WHERE job_id = $1 AND operation_key = $2
         ORDER BY attempt_number DESC
         LIMIT 1`,
        [jobId, operationKey],
      );

      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        jobId: row.job_id,
        workspaceId: row.workspace_id,
        provider: row.provider,
        operationKey: row.operation_key,
        operationType: row.operation_type,
        providerOperationId: row.provider_operation_id,
        status: row.status,
        attemptNumber: Number(row.attempt_number),
        responseMetadata: row.response_metadata,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      };
    } catch (error) {
      mapDatabaseError(error, jobId);
    }
  }
}
