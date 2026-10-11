import type { JobRecord, JobRepository } from '../../db/job-repository';
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
    private readonly gemini: GeminiAdapter,
  ) {}

  async execute(
    context: ExecutionContext,
    job: JobRecord,
    signal: AbortSignal,
  ): Promise<WorkerHandlerResult> {
    const existing = await this.jobs.getLatestOperation(job.id, OPERATION_KEY);
    if (existing?.status === 'succeeded') return { kind: 'completed' };

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

    await context.executeProviderTask(
      'gemini',
      OPERATION_KEY,
      'product_dna',
      { mode: 'product_dna' },
      async (operationId) => {
        const result = await this.gemini.submit(
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
          providerOperationId: result.providerOperationId,
          metadata: {
            provider: result.metadata,
            response: result.responsePayload,
          },
        };
      },
    );

    return { kind: 'completed' };
  }
}
