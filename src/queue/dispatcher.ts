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

        await this.queue.addJob(message.queueName, { jobId: message.jobId });
        await this.outbox.complete(message.outboxId, message.claimToken);
        completed += 1;
      } catch (error) {
        failed += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);

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
