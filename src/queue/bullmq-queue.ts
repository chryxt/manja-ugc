import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { DispatchQueue, JobQueuePayload } from './types';

export interface BullMQDispatchQueueOptions {
  connection: ConnectionOptions;
  defaultJobOptions?: JobsOptions;
}

const SAFE_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5_000,
  },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

export class BullMQDispatchQueue implements DispatchQueue {
  private readonly queues = new Map<string, Queue<JobQueuePayload>>();

  constructor(private readonly options: BullMQDispatchQueueOptions) {}

  async addJob(queueName: string, payload: JobQueuePayload): Promise<void> {
    const queue = this.getQueue(queueName);

    await queue.add('execute-job', payload, {
      ...this.getDefaultJobOptions(),
      // Deterministic identity makes repeated outbox delivery converge on one BullMQ job.
      jobId: payload.jobId,
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private getQueue(queueName: string): Queue<JobQueuePayload> {
    const existing = this.queues.get(queueName);
    if (existing) return existing;

    const queue = new Queue<JobQueuePayload>(queueName, {
      connection: this.options.connection,
      defaultJobOptions: this.getDefaultJobOptions(),
    });
    this.queues.set(queueName, queue);
    return queue;
  }

  private getDefaultJobOptions(): JobsOptions {
    return {
      ...SAFE_DEFAULT_JOB_OPTIONS,
      ...this.options.defaultJobOptions,
      backoff: this.options.defaultJobOptions?.backoff ?? SAFE_DEFAULT_JOB_OPTIONS.backoff,
    };
  }
}
