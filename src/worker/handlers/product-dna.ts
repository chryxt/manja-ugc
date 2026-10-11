import type { JobOperationRecord, JobRecord, JobRepository } from '../../db/job-repository';
import type { DomainPersistence } from '../../domain/persistence';
import type { GeminiAdapter } from '../../providers/gemini/gemini-adapter';
import { ProviderErrorClassification, ProviderExecutionError } from '../../providers/types';
import type { WorkerHandlerResult, WorkerJobHandler } from '../job-processor';
import type { ExecutionContext } from '../execution-context';
import type { JobDomainInputResolver } from './domain-inputs';

const OPERATION_KEY = 'product_dna_extract';

export class ProductDnaHandler implements WorkerJobHandler {
  constructor(
    private readonly jobs: JobRepository,
    private readonly inputs: JobDomainInputResolver,
    private readonly persistence: DomainPersistence,
    private readonly gemini: GeminiAdapter,
  ) {}

  async execute(
    context: ExecutionContext,
    job: JobRecord,
    signal: AbortSignal,
  ): Promise<WorkerHandlerResult> {
    const existing = await this.jobs.getLatestOperation(job.id, OPERATION_KEY);
    if (existing?.status === 'succeeded') {
      await this.persistFromOperation(job, existing);
      return { kind: 'completed' };
    }

    // Gemini synchronous requests have no verified external idempotency primitive. If a
    // previous worker died while the request outcome was ambiguous, auto-resubmission could
    // double-spend provider cost. Stop for operator reconciliation instead.
    if (existing && (existing.status === 'in_progress' || existing.status === 'submitted')) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'GEMINI_AMBIGUOUS_SYNC_OPERATION',
        `Product DNA operation ${existing.id} is non-terminal after worker recovery`,
        existing,
      );
    }

    const payload = await this.inputs.getProductDnaPayload(job);

    const result = await context.executeProviderTask(
      'gemini',
      OPERATION_KEY,
      'product_dna',
      { mode: 'product_dna' },
      async (operationId) => {
        const providerResult = await this.gemini.submit(
          operationId,
          'product_dna',
          payload,
          {
            jobId: job.id,
            operationId,
            workspaceId: job.workspaceId,
          },
          signal,
        );

        return {
          providerOperationId: providerResult.providerOperationId,
          metadata: {
            provider: providerResult.metadata,
            response: providerResult.responsePayload,
          },
        };
      },
    );

    const metadata = result.metadata as { response?: unknown } | undefined;
    if (metadata?.response === undefined) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'PRODUCT_DNA_RESULT_MISSING',
        'Gemini Product DNA operation completed without a persisted response payload',
      );
    }

    await this.persistence.saveProductDna(job, metadata.response);
    return { kind: 'completed' };
  }

  private async persistFromOperation(job: JobRecord, operation: JobOperationRecord): Promise<void> {
    const metadata = operation.responseMetadata as { response?: unknown } | null;
    if (metadata?.response === undefined) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'PRODUCT_DNA_RESULT_MISSING',
        `Succeeded Product DNA operation ${operation.id} has no response payload`,
        operation,
      );
    }

    await this.persistence.saveProductDna(job, metadata.response);
  }
}
