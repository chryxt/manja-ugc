import {
  ApiError,
  GenerateVideosOperation,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GenerateVideosParameters,
  type GenerateVideosResponse,
} from '@google/genai';
import {
  type IAIProviderAdapter,
  type ProviderAdapterCapabilities,
  ProviderErrorClassification,
  ProviderExecutionError,
  type ProviderRequestMetadata,
  type ProviderStatusResult,
  type ProviderSubmissionResult,
} from '../types';

export interface GeminiTextPayload {
  kind: 'text';
  model: string;
  contents: GenerateContentParameters['contents'];
  config?: GenerateContentParameters['config'];
}

export interface GeminiVideoPayload {
  kind: 'video';
  model: string;
  source: NonNullable<GenerateVideosParameters['source']>;
  config?: GenerateVideosParameters['config'];
}

export type GeminiProviderPayload = GeminiTextPayload | GeminiVideoPayload;
export type GeminiProviderResponse = GenerateContentResponse | GenerateVideosResponse;

export interface GeminiProviderMetadata {
  operationType: string;
  mode: 'sync' | 'async';
  model?: string;
  operationId?: string;
  usageMetadata?: GenerateContentResponse['usageMetadata'];
  finishReason?: string;
  operationMetadata?: Record<string, unknown>;
}

export interface GeminiAdapterOptions {
  client?: GoogleGenAI;
  apiKey?: string;
}

export class GeminiAdapter
  implements IAIProviderAdapter<GeminiProviderPayload, GeminiProviderResponse, GeminiProviderMetadata>
{
  readonly providerName = 'gemini' as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    externalIdempotency: false,
    asyncStatus: true,
    cancellation: 'none',
  };

  private readonly client: GoogleGenAI;

  constructor(options: GeminiAdapterOptions = {}) {
    this.client = options.client ?? new GoogleGenAI(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async submit(
    operationId: string,
    operationType: string,
    payload: GeminiProviderPayload,
    context: ProviderRequestMetadata,
    abortSignal?: AbortSignal,
  ): Promise<ProviderSubmissionResult<GeminiProviderResponse, GeminiProviderMetadata>> {
    this.assertContext(operationId, context);

    try {
      if (payload.kind === 'text') {
        const response = await this.client.models.generateContent({
          model: payload.model,
          contents: payload.contents,
          config: {
            ...payload.config,
            abortSignal,
          },
        });

        const finishReason = response.candidates?.[0]?.finishReason;
        if (finishReason && isPermanentFinishReason(String(finishReason))) {
          throw new ProviderExecutionError(
            ProviderErrorClassification.PERMANENT,
            `GEMINI_FINISH_${String(finishReason)}`,
            `Gemini generation stopped with finish reason ${String(finishReason)}`,
            response,
          );
        }

        return {
          // Gemini generateContent is synchronous and does not expose a provider operation ID.
          // This deterministic local correlation ID is never treated as external idempotency.
          providerOperationId: `sync:${operationId}`,
          responsePayload: response,
          metadata: {
            operationType,
            mode: 'sync',
            model: payload.model,
            operationId,
            usageMetadata: response.usageMetadata,
            finishReason: finishReason ? String(finishReason) : undefined,
          },
        };
      }

      const operation = await this.client.models.generateVideos({
        model: payload.model,
        source: payload.source,
        config: {
          ...payload.config,
          abortSignal,
        },
      });

      if (!operation.name) {
        throw new ProviderExecutionError(
          ProviderErrorClassification.FATAL_P0,
          'GEMINI_MISSING_OPERATION_NAME',
          'Veo returned a long-running operation without a name',
          operation,
        );
      }

      if (operation.done && operation.error) {
        throw operationError(operation.error);
      }

      return {
        providerOperationId: operation.name,
        responsePayload: operation.response,
        metadata: {
          operationType,
          mode: 'async',
          model: payload.model,
          operationId,
          operationMetadata: operation.metadata,
        },
      };
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw normalizeGeminiError(error);
    }
  }

  async getStatus(
    providerOperationId: string,
    operationType: string,
    _abortSignal?: AbortSignal,
  ): Promise<ProviderStatusResult<GeminiProviderResponse, GeminiProviderMetadata>> {
    if (providerOperationId.startsWith('sync:')) {
      return {
        isTerminal: true,
        isSuccess: true,
        metadata: {
          operationType,
          mode: 'sync',
          operationId: providerOperationId.slice('sync:'.length),
        },
      };
    }

    try {
      const handle = new GenerateVideosOperation();
      handle.name = providerOperationId;

      const operation = await this.client.operations.getVideosOperation({ operation: handle });

      if (!operation.done) {
        return {
          isTerminal: false,
          isSuccess: false,
          metadata: {
            operationType,
            mode: 'async',
            operationMetadata: operation.metadata,
          },
        };
      }

      if (operation.error) {
        const normalized = operationError(operation.error);
        return {
          isTerminal: true,
          isSuccess: false,
          metadata: {
            operationType,
            mode: 'async',
            operationMetadata: operation.metadata,
          },
          error: {
            code: normalized.providerCode,
            message: normalized.message,
            classification: normalized.classification,
          },
        };
      }

      return {
        isTerminal: true,
        isSuccess: true,
        responsePayload: operation.response,
        metadata: {
          operationType,
          mode: 'async',
          operationMetadata: operation.metadata,
        },
      };
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw normalizeGeminiError(error);
    }
  }

  private assertContext(operationId: string, context: ProviderRequestMetadata): void {
    if (context.operationId !== operationId) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'PROVIDER_CONTEXT_MISMATCH',
        `Provider context operationId does not match operation ${operationId}`,
      );
    }
  }
}

export function normalizeGeminiError(error: unknown): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;

  const err = error as {
    name?: string;
    message?: string;
    status?: number;
    code?: string | number;
  };

  const status = error instanceof ApiError ? error.status : err.status;
  const message = err.message ?? 'Unknown Gemini provider error';
  const code = String(err.code ?? status ?? err.name ?? 'GEMINI_UNKNOWN');

  if (err.name === 'AbortError' || /aborted|abort signal/i.test(message)) {
    return new ProviderExecutionError(
      ProviderErrorClassification.TRANSIENT,
      'GEMINI_CLIENT_ABORTED',
      message,
      error,
      status,
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderExecutionError(
      ProviderErrorClassification.FATAL_P0,
      code,
      message,
      error,
      status,
    );
  }

  if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return new ProviderExecutionError(
      ProviderErrorClassification.TRANSIENT,
      code,
      message,
      error,
      status,
    );
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderExecutionError(
      ProviderErrorClassification.PERMANENT,
      code,
      message,
      error,
      status,
    );
  }

  // Unknown transport/provider failures receive the bounded BullMQ retry budget.
  return new ProviderExecutionError(
    ProviderErrorClassification.TRANSIENT,
    code,
    message,
    error,
    status,
  );
}

function operationError(error: Record<string, unknown>): ProviderExecutionError {
  const rawCode = error.code;
  const numericStatus = typeof rawCode === 'number' ? rawCode : undefined;
  const code = String(rawCode ?? 'GEMINI_OPERATION_FAILED');
  const message = typeof error.message === 'string' ? error.message : 'Gemini/Veo long-running operation failed';

  let classification = ProviderErrorClassification.PERMANENT;
  if (numericStatus === 401 || numericStatus === 403) {
    classification = ProviderErrorClassification.FATAL_P0;
  } else if (
    numericStatus === 408 ||
    numericStatus === 409 ||
    numericStatus === 425 ||
    numericStatus === 429 ||
    (numericStatus !== undefined && numericStatus >= 500)
  ) {
    classification = ProviderErrorClassification.TRANSIENT;
  }

  return new ProviderExecutionError(classification, code, message, error, numericStatus);
}

function isPermanentFinishReason(reason: string): boolean {
  return new Set([
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
  ]).has(reason.toUpperCase());
}
