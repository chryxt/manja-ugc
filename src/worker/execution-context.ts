import type { AIProvider, ExecutionLease, JobOperationStatus, JobRPC, JobStatus } from '../db/job-rpc';

export interface ProviderCallResult {
  providerOperationId?: string;
  metadata?: unknown;
}

export interface AsyncProviderSubmissionResult extends ProviderCallResult {
  providerOperationId: string;
}

export class ExecutionContext {
  constructor(
    private readonly rpc: JobRPC,
    readonly lease: ExecutionLease,
  ) {}

  get jobId(): string {
    return this.lease.jobId;
  }

  async heartbeat(ttlSeconds = 60): Promise<Date> {
    return this.rpc.renewExecutionLease(this.lease, ttlSeconds);
  }

  async assertLease(): Promise<void> {
    await this.rpc.assertExecutionLease(this.lease);
  }

  async transition(newStatus: JobStatus, newStep?: string): Promise<void> {
    await this.assertLease();
    await this.rpc.transitionJobState(this.jobId, newStatus, newStep);
  }

  async executeProviderTask(
    provider: AIProvider,
    operationKey: string,
    operationType: string,
    requestMetadata: unknown,
    providerCall: (operationId: string) => Promise<ProviderCallResult>,
  ): Promise<ProviderCallResult> {
    await this.assertLease();

    const operationId = await this.rpc.startOperation(
      this.jobId,
      provider,
      operationKey,
      operationType,
      requestMetadata,
    );

    await this.assertLease();

    try {
      const result = await providerCall(operationId);
      await this.rpc.finalizeOperation(
        this.jobId,
        operationId,
        'succeeded',
        result.providerOperationId,
        result.metadata,
      );
      return result;
    } catch (error) {
      const providerError = error as { code?: string; providerCode?: string; message?: string };
      await this.safeFinalizeOperation(
        operationId,
        'failed',
        providerError.providerCode ?? providerError.code ?? 'PROVIDER_ERROR',
        providerError.message ?? 'Provider call failed',
      );
      throw error;
    }
  }

  async submitAsyncProviderTask(
    provider: AIProvider,
    operationKey: string,
    operationType: string,
    requestMetadata: unknown,
    providerCall: (operationId: string) => Promise<AsyncProviderSubmissionResult>,
  ): Promise<{ operationId: string; submission: AsyncProviderSubmissionResult }> {
    await this.assertLease();

    const operationId = await this.rpc.startOperation(
      this.jobId,
      provider,
      operationKey,
      operationType,
      requestMetadata,
    );

    await this.assertLease();

    try {
      const submission = await providerCall(operationId);
      await this.rpc.recordOperationSubmission(
        this.jobId,
        operationId,
        submission.providerOperationId,
        submission.metadata,
      );
      return { operationId, submission };
    } catch (error) {
      const providerError = error as { code?: string; providerCode?: string; message?: string };
      await this.safeFinalizeOperation(
        operationId,
        'failed',
        providerError.providerCode ?? providerError.code ?? 'PROVIDER_ERROR',
        providerError.message ?? 'Provider submission failed',
      );
      throw error;
    }
  }

  async finalizeSubmittedOperation(
    operationId: string,
    outcome: Extract<JobOperationStatus, 'succeeded' | 'failed' | 'cancelled'>,
    providerOperationId?: string,
    responseMetadata?: unknown,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    await this.assertLease();
    await this.rpc.finalizeOperation(
      this.jobId,
      operationId,
      outcome,
      providerOperationId,
      responseMetadata,
      errorCode,
      errorMessage,
    );
  }

  async scheduleWakeup(operationId: string, delaySeconds = 15): Promise<string> {
    await this.assertLease();
    return this.rpc.scheduleJobWakeup(this.jobId, operationId, delaySeconds);
  }

  private async safeFinalizeOperation(
    operationId: string,
    outcome: Extract<JobOperationStatus, 'failed' | 'cancelled'>,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.rpc.finalizeOperation(
        this.jobId,
        operationId,
        outcome,
        undefined,
        undefined,
        errorCode,
        errorMessage,
      );
    } catch {
      // The DB is authoritative. A competing terminal/cancellation path may have won.
    }
  }
}
