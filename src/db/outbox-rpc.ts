import type { Pool } from 'pg';
import { mapDatabaseError } from './errors';

export interface ClaimedOutboxMessage {
  outboxId: string;
  jobId: string;
  queueName: string;
  payload: { jobId: string };
  claimToken: string;
  leaseExpiresAt: Date;
  attemptCount: number;
}

export class OutboxRPC {
  constructor(private readonly pool: Pool) {}

  async claimBatch(
    dispatcherId: string,
    batchSize = 50,
    leaseSeconds = 60,
  ): Promise<ClaimedOutboxMessage[]> {
    try {
      const result = await this.pool.query<{
        outbox_id: string;
        job_id: string;
        queue_name: string;
        payload: { jobId: string };
        claim_token: string;
        lease_expires_at: Date;
        attempt_count: number;
      }>(
        `SELECT * FROM private.claim_outbox_messages($1, $2, $3)`,
        [dispatcherId, batchSize, leaseSeconds],
      );

      return result.rows.map((row) => ({
        outboxId: row.outbox_id,
        jobId: row.job_id,
        queueName: row.queue_name,
        payload: row.payload,
        claimToken: row.claim_token,
        leaseExpiresAt: row.lease_expires_at,
        attemptCount: Number(row.attempt_count),
      }));
    } catch (error) {
      mapDatabaseError(error);
    }
  }

  async complete(outboxId: string, claimToken: string): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.complete_outbox_message($1, $2)`,
        [outboxId, claimToken],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
  }

  async fail(
    outboxId: string,
    claimToken: string,
    message: string,
    retryDelaySeconds = 5,
    maxAttempts = 10,
  ): Promise<void> {
    try {
      await this.pool.query(
        `SELECT private.fail_outbox_message($1, $2, $3, $4, $5)`,
        [outboxId, claimToken, message, retryDelaySeconds, maxAttempts],
      );
    } catch (error) {
      mapDatabaseError(error);
    }
  }
}
