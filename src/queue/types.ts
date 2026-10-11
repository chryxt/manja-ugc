export interface JobQueuePayload {
  jobId: string;
}

export interface DispatchQueue {
  addJob(queueName: string, payload: JobQueuePayload): Promise<void>;
}
