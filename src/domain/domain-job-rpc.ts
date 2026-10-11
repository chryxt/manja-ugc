import type { Pool } from 'pg';
import { mapDatabaseError } from '../db/errors';

export interface CreateDomainJobInput {
  workspaceId: string;
  jobType: 'product_dna' | 'catalog_image' | 'ugc_video';
  actorUserId: string;
  idempotencyKey: string;
  productId?: string;
  storyboardId?: string;
}

export class DomainJobRPC {
  constructor(private readonly pool: Pool) {}

  async createAndReserve(input: CreateDomainJobInput): Promise<string> {
    try {
      const result = await this.pool.query<{ job_id: string }>(
        `SELECT private.create_domain_job_and_reserve_credits($1,$2,$3,$4,$5,$6) AS job_id`,
        [
          input.workspaceId,
          input.jobType,
          input.actorUserId,
          input.idempotencyKey,
          input.productId ?? null,
          input.storyboardId ?? null,
        ],
      );
      return result.rows[0].job_id;
    } catch (error) {
      mapDatabaseError(error);
    }
  }
}
