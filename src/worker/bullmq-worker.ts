import { Worker, type ConnectionOptions, type WorkerOptions } from 'bullmq';
import type { JobQueuePayload } from '../queue/types';
import type { JobProcessor } from './job-processor';

export interface BullMQWorkerPolicy {
  connection: ConnectionOptions;
  queueName?: string;
  concurrency?: number;
  rateLimit?: {
    max: number;
    durationMs: number;
  };
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
}

export function createBullMQWorker(
  processor: JobProcessor,
  policy: BullMQWorkerPolicy,
): Worker<JobQueuePayload, void, string> {
  const options: WorkerOptions = {
    connection: policy.connection,
    concurrency: policy.concurrency ?? 4,
    lockDuration: policy.lockDurationMs ?? 60_000,
    stalledInterval: policy.stalledIntervalMs ?? 30_000,
    maxStalledCount: policy.maxStalledCount ?? 1,
    ...(policy.rateLimit
      ? {
          limiter: {
            max: policy.rateLimit.max,
            duration: policy.rateLimit.durationMs,
          },
        }
      : {}),
  };

  return new Worker<JobQueuePayload, void, string>(
    policy.queueName ?? 'ugc-jobs',
    async (queueJob) => {
      const configuredAttempts = Math.max(1, Number(queueJob.opts.attempts ?? 1));
      const isFinalAttempt = queueJob.attemptsMade + 1 >= configuredAttempts;

      await processor.process(queueJob.data.jobId, { isFinalAttempt });
    },
    options,
  );
}
