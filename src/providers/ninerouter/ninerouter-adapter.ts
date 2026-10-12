import OpenAI from 'openai';
import {
  ProviderErrorClassification,
  ProviderExecutionError,
  type IAIProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderRequestMetadata,
  type ProviderStatusResult,
  type ProviderSubmissionResult,
} from '../types';

export interface NineRouterTextPayload {
  model: string;
  input: string;
  temperature?: number;
  maxTokens?: number;
}

export interface NineRouterTextResponse {
  id: string;
  output_text: string;
  model?: string;
  usage?: unknown;
}

export interface NineRouterMetadata {
  operationType: string;
  model?: string;
  usage?: unknown;
  baseUrl: string;
}

export interface NineRouterAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  client?: OpenAI;
  timeoutMs?: number;
}

/**
 * 9Router exposes an OpenAI-compatible endpoint. This adapter intentionally uses
 * synchronous chat completions only. 9Router itself owns provider/account routing;
 * MANJA never rotates provider credentials or subscription accounts directly.
 */
export class NineRouterAdapter
  implements IAIProviderAdapter<NineRouterTextPayload, NineRouterTextResponse, NineRouterMetadata>
{
  readonly providerName = 'ninerouter' as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    externalIdempotency: false,
    asyncStatus: false,
    cancellation: 'none',
  };

  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: NineRouterAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.NINEROUTER_BASE_URL ?? 'http://127.0.0.1:20128/v1',
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey ?? process.env.NINEROUTER_API_KEY ?? '9router-local',
        baseURL: this.baseUrl,
        maxRetries: 0,
      });
  }

  async submit(
    operationId: string,
    operationType: string,
    payload: NineRouterTextPayload,
    context: ProviderRequestMetadata,
    abortSignal?: AbortSignal,
  ): Promise<ProviderSubmissionResult<NineRouterTextResponse, NineRouterMetadata>> {
    if (operationId !== context.operationId) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.FATAL_P0,
        'NINEROUTER_OPERATION_CONTEXT_MISMATCH',
        '9Router operation id does not match execution context',
      );
    }

    if (!payload.model || !payload.input) {
      throw new ProviderExecutionError(
        ProviderErrorClassification.PERMANENT,
        'NINEROUTER_INVALID_PAYLOAD',
        '9Router text payload requires model and input',
      );
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: payload.model,
          messages: [{ role: 'user', content: payload.input }],
          temperature: payload.temperature,
          max_tokens: payload.maxTokens,
          stream: false,
        },
        {
          signal: abortSignal,
          maxRetries: 0,
          timeout: this.timeoutMs,
        },
      );

      const output = response.choices[0]?.message?.content;
      if (typeof output !== 'string' || output.length === 0) {
        throw new ProviderExecutionError(
          ProviderErrorClassification.PERMANENT,
          'NINEROUTER_EMPTY_OUTPUT',
          '9Router completed text generation without output text',
          response,
        );
      }

      const normalized: NineRouterTextResponse = {
        id: response.id || `ninerouter:${operationId}`,
        output_text: output,
        model: response.model,
        usage: response.usage,
      };

      return {
        providerOperationId: normalized.id,
        responsePayload: normalized,
        metadata: {
          operationType,
          model: response.model,
          usage: response.usage,
          baseUrl: this.baseUrl,
        },
      };
    } catch (error) {
      if (error instanceof ProviderExecutionError) throw error;
      throw normalizeNineRouterError(error);
    }
  }

  async getStatus(): Promise<ProviderStatusResult<NineRouterTextResponse, NineRouterMetadata>> {
    throw new ProviderExecutionError(
      ProviderErrorClassification.FATAL_P0,
      'NINEROUTER_ASYNC_STATUS_UNSUPPORTED',
      '9Router text adapter is synchronous and does not expose provider-operation polling',
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function normalizeNineRouterError(error: unknown): ProviderExecutionError {
  const value = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const status = value.status;
  const code = value.code ?? value.name ?? 'NINEROUTER_ERROR';
  const message = value.message ?? '9Router request failed';

  if (status === 429 || status === 503) {
    return new ProviderExecutionError(
      ProviderErrorClassification.TRANSIENT,
      code,
      message,
      error,
      status,
    );
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new ProviderExecutionError(
      ProviderErrorClassification.PERMANENT,
      code,
      message,
      error,
      status,
    );
  }

  // 9Router has no verified external idempotency primitive for chat completions.
  // Transport/timeout ambiguity must not trigger blind app-level resubmission.
  return new ProviderExecutionError(
    ProviderErrorClassification.FATAL_P0,
    code,
    message,
    error,
    status,
  );
}
