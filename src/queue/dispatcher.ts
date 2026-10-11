import { OutboxRPC } from '../db/outbox-rpc';
import type { DispatchQueue } from './types';

export interface DispatcherOptions {
  dispatcherId: string;
  batchSize?: number;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  maxAttempts?: number;
}

export interface DispatchCycleResult {
  claimed: number;
  completed: number;
  failed: number;
}

export class OutboxDispatcher {
  constructor(
    private readonly outbox: OutboxRPC,
    private readonly queue: DispatchQueue,
    private readonly options: DispatcherOptions,
  ) {}

  async dispatchOnce(): Promise<DispatchCycleResult> {
    const messages = await this.outbox.claimBatch(
      this.options.dispatcherId,
      this.options.batchSize ?? 50,
      this.options.leaseSeconds ?? 60,
    );

    let completed = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        if (message.payload.jobId !== message.jobId) {
          throw new Error(`Outbox payload jobId mismatch for ${message.outboxId}`);
        }

        // BullMQ custom job IDs must not contain ':' because it is used as an
        // internal Redis key separator. Keep the delivery identity deterministic
        // while using a BullMQ-safe separator.
        const deliveryId = `${message.outboxId}-${message.attemptCount}`;
        await this.queue.addJob(message.queueName, { jobId: message.jobId }, deliveryId);
        await this.outbox.complete(message.outboxId, message.claimToken);
        completed += 1;
      } catch (error) {
        failed += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `[outbox] dispatch failed outbox=${message.outboxId} attempt=${message.attemptCount} message=${sanitize(errorMessage)}`,
        );

        try {
          await this.outbox.fail(
            message.outboxId,
            message.claimToken,
            errorMessage,
            this.options.retryDelaySeconds ?? 5,
            this.options.maxAttempts ?? 10,
          );
        } catch {
          // The claim may already have been recovered/fenced by another dispatcher.
          // Do not let one stale acknowledgement abort the rest of this batch.
        }
      }
    }

    return { claimed: messages.length, completed, failed };
  }
}

function sanitize(value: string): string {
  return value
    .replace(/redis(?:s)?:\/\/[^\s]+/gi, '[redacted-redis-url]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-postgres-url]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 1000);
}
