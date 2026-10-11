import type { JobOperationRecord, JobRecord, JobRepository } from '../../db/job-repository';
import type { GeminiAdapter } from '../../providers/gemini/gemini-adapter';
import type { OpenAIAdapter } from '../../providers/openai/openai-adapter';
import { ProviderErrorClassification, ProviderExecutionError } from '../../providers/types';
import type { ExecutionContext } from '../execution-context';
import type { WorkerHandlerResult, WorkerJobHandler } from '../job-processor';
import type { JobDomainInputResolver } from './domain-inputs';

const SCRIPT_OPERATION_KEY = 'ugc_script_generation';
const VIDEO_OPERATION_KEY = 'veo_video_generation';

export interface UgcVideoHandlerOptions {
  pollDelaySeconds?: number;
}

export class UgcVideoHandler implements WorkerJobHandler {
  private readonly pollDelaySeconds: number;

  constructor(
    private readonly jobs: JobRepository,
    private readonly inputs: JobDomainInputResolver,
    private readonly openai: OpenAIAdapter,
    private readonly gemini: GeminiAdapter,
    options: UgcVideoHandlerOptions = {},
  ) {
    this.pollDelaySeconds = options.pollDelaySeconds ?? 20;
  }

  async execute(
    context: ExecutionContext,
    job: JobRecord,
    signal: AbortSignal,
  ): Promise<WorkerHandlerResult> {
    const script = await this.ensureScript(context, job, signal);
    const videoOperation = await this.jobs.getLatestOperation(job.id, VIDEO_OPERATION_KEY);

    if (!videoOperation) {
      if (job.status !== 'waiting_provider') {
        await context.transition('waiting_provider', 'submitting_veo_video');
      }

      const payload = await this.inputs.getVeoPayload(job, script);
      const { operationId } = await context.submitAsyncProviderTask(
        'gemini',
        VIDEO_OPERATION_KEY,
        'video_generation',
        { mode: 'veo', model: payload.model },
        async (dbOperationId) => {
          const submission = await this.gemini.submit(
            dbOperationId,
            'video_generation',
            payload,
            {
              jobId: job.id,
              operationId: dbOperationId,
              workspaceId: job.workspaceId,
            },
            signal,
          );

          return {
            providerOperationId: submission.providerOperationId,
            metadata: submission.metadata,
          };
        },
      );

      await context.scheduleWakeup(operationId, this.pollDelaySeconds);
      return { kind: 'deferred' };
    }

    if (videoOperation.status === 'succeeded') {
      return { kind: 'completed' };
    }

    if (videoOperation.status === 'failed' || videoOperation.status === 'cancelled') {
      throw new ProviderExecutionError(
        ProviderErrorClassification.PERMANENT,
        videoOperation.errorCode ?? 'VEO_OPERATION_TERMINAL',
        videoOperation.errorMessage ?? `Veo operation is ${videoOperation.status}`,
        videoOperation,
      );
    }

    if (!videoOperation.providerOperationId) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'VEO_PROVIDER_OPERATION_ID_MISSING',
        `Async Veo operation ${videoOperation.id} has no provider operation id`,
        videoOperation,
      );
    }

    const status = await this.gemini.getStatus(
      videoOperation.providerOperationId,
      'video_generation',
      signal,
    );

    if (!status.isTerminal) {
      await context.scheduleWakeup(videoOperation.id, this.pollDelaySeconds);
      return { kind: 'deferred' };
    }

    if (!status.isSuccess) {
      const providerError = status.error ?? {
        code: 'VEO_OPERATION_FAILED',
        message: 'Veo operation failed without provider error details',
        classification: ProviderErrorClassification.PERMANENT,
      };

      await context.finalizeSubmittedOperation(
        videoOperation.id,
        'failed',
        videoOperation.providerOperationId,
        status.metadata,
        providerError.code,
        providerError.message,
      );

      throw new ProviderExecutionError(
        providerError.classification,
        providerError.code,
        providerError.message,
        status,
      );
    }

    await context.finalizeSubmittedOperation(
      videoOperation.id,
      'succeeded',
      videoOperation.providerOperationId,
      {
        provider: status.metadata,
        response: status.responsePayload,
      },
    );

    return { kind: 'completed' };
  }

  private async ensureScript(
    context: ExecutionContext,
    job: JobRecord,
    signal: AbortSignal,
  ): Promise<string> {
    const existing = await this.jobs.getLatestOperation(job.id, SCRIPT_OPERATION_KEY);
    if (existing?.status === 'succeeded') {
      const script = scriptFromOperation(existing);
      if (script) return script;
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'UGC_SCRIPT_RESULT_MISSING',
        `Succeeded script operation ${existing.id} has no persisted script`,
        existing,
      );
    }

    if (existing?.status === 'failed' || existing?.status === 'cancelled') {
      throw new ProviderExecutionError(
        ProviderErrorClassification.PERMANENT,
        existing.errorCode ?? 'UGC_SCRIPT_TERMINAL',
        existing.errorMessage ?? `Script operation is ${existing.status}`,
        existing,
      );
    }

    const payload = await this.inputs.getUgcScriptPayload(job);
    let generatedScript = '';

    await context.executeProviderTask(
      'openai',
      SCRIPT_OPERATION_KEY,
      'script_generation',
      { mode: 'ugc_script' },
      async (operationId) => {
        const result = await this.openai.submit(
          operationId,
          'script_generation',
          payload,
          {
            jobId: job.id,
            operationId,
            workspaceId: job.workspaceId,
          },
          signal,
        );

        generatedScript = result.responsePayload?.output_text ?? '';
        if (!generatedScript) {
          throw new ProviderExecutionError(
            ProviderErrorClassification.PERMANENT,
            'OPENAI_EMPTY_SCRIPT',
            'OpenAI completed script generation without output text',
            result.responsePayload,
          );
        }

        return {
          providerOperationId: result.providerOperationId,
          metadata: {
            provider: result.metadata,
            script: generatedScript,
          },
        };
      },
    );

    return generatedScript;
  }
}

function scriptFromOperation(operation: JobOperationRecord): string | null {
  const metadata = operation.responseMetadata as { script?: unknown } | null;
  return typeof metadata?.script === 'string' && metadata.script.length > 0
    ? metadata.script
    : null;
}
