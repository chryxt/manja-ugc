import type { AIProvider, ExecutionLease, JobOperationStatus, JobRPC } from '../db/job-rpc';

export interface ProviderCallResult {
  providerOperationId?: string;
  metadata?: unknown;
}

export class ExecutionContext {
  constructor(
    private readonly rpc: JobRPC,
    readonly lease: ExecutionLease,
  ) {}

  async heartbeat(ttlSeconds = 60): Promise<Date> {
    return this.rpc.renewExecutionLease(this.lease, ttlSeconds);
  }

  async assertLease(): Promise<void> {
    await this.rpc.assertExecutionLease(this.lease);
  }

  async executeProviderTask(
    provider: AIProvider,
    operationKey: string,
    operationType: string,
    requestMetadata: unknown,
    providerCall: (operationId: string) => Promise<ProviderCallResult>,
  ): Promise<ProviderCallResult> {
    // Spending gate #1: stale/fenced workers stop before creating a provider operation.
    await this.assertLease();

    const operationId = await this.rpc.startOperation(
      this.lease.jobId,
      provider,
      operationKey,
      operationType,
      requestMetadata,
    );

    // Spending gate #2: re-check immediately before the external side effect.
    // This narrows the lease-expiry window after the DB operation was recorded.
    await this.assertLease();

    try {
      const result = await providerCall(operationId);
      await this.rpc.finalizeOperation(
        this.lease.jobId,
        operationId,
        'succeeded',
        result.providerOperationId,
        result.metadata,
      );
      return result;
    } catch (error) {
      const providerError = error as { code?: string; message?: string };
      await this.safeFinalizeOperation(
        operationId,
        'failed',
        providerError.code ?? 'PROVIDER_ERROR',
        providerError.message ?? 'Provider call failed',
      );
      throw error;
    }
  }

  private async safeFinalizeOperation(
    operationId: string,
    outcome: Extract<JobOperationStatus, 'failed' | 'cancelled'>,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.rpc.finalizeOperation(
        this.lease.jobId,
        operationId,
        outcome,
        undefined,
        undefined,
        errorCode,
        errorMessage,
      );
    } catch {
      // The DB is authoritative. A competing terminal/cancellation path may have won.
      // Caller still receives the original provider error.
    }
  }
}
