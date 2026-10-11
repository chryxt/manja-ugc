import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { DispatchQueue, JobQueuePayload } from './types';

export interface BullMQDispatchQueueOptions {
  connection: ConnectionOptions;
  defaultJobOptions?: JobsOptions;
}

export class BullMQDispatchQueue implements DispatchQueue {
  private readonly queues = new Map<string, Queue<JobQueuePayload>>();

  constructor(private readonly options: BullMQDispatchQueueOptions) {}

  async addJob(queueName: string, payload: JobQueuePayload): Promise<void> {
    const queue = this.getQueue(queueName);

    await queue.add('execute-job', payload, {
      ...this.options.defaultJobOptions,
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
      defaultJobOptions: this.options.defaultJobOptions,
    });
    this.queues.set(queueName, queue);
    return queue;
  }
}
