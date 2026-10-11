import type { JobRecord, JobRepository } from '../../db/job-repository';
import type { GeminiAdapter } from '../../providers/gemini/gemini-adapter';
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

    await context.transition('processing', 'analyzing_product_assets');
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
          // Store enough result material on the operation for crash-safe recovery until
          // the dedicated Product DNA persistence model is introduced.
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
