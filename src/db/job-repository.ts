import type { Pool } from 'pg';
import { JobNotFoundError, mapDatabaseError } from './errors';
import type { JobStatus } from './job-rpc';

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
}
