import OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import {
  ProviderErrorClassification,
  ProviderExecutionError,
  type IAIProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderRequestMetadata,
  type ProviderStatusResult,
  type ProviderSubmissionResult,
} from '../types';

export type OpenAIProviderPayload = Omit<ResponseCreateParamsNonStreaming, 'stream'>;

export interface OpenAIProviderMetadata {
  operationType: string;
  requestId?: string;
  responseStatus: string;
  model?: string;
  usage?: unknown;
}

export interface OpenAIAdapterOptions {
  apiKey?: string;
  client?: OpenAI;
  timeoutMs?: number;
}

export class OpenAIAdapter
  implements IAIProviderAdapter<OpenAIProviderPayload, OpenAIResponse, OpenAIProviderMetadata>
{
  readonly providerName = 'openai' as const;
  readonly capabilities: ProviderAdapterCapabilities = {
    externalIdempotency: true,
    asyncStatus: true,
    cancellation: 'background-only',
  };

  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
        // Retry ownership belongs to BullMQ / Worker Policy. Avoid nested hidden retries.
        maxRetries: 0,
      });
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async submit(
    operationId: string,
    operationType: string,
    payload: OpenAIProviderPayload,
    context: ProviderRequestMetadata,
    abortSignal?: AbortSignal,
  ): Promise<ProviderSubmissionResult<OpenAIResponse, OpenAIProviderMetadata>> {
    this.assertContext(operationId, context);

    try {
      const response = await this.client.responses.create(
        {
          ...payload,
          stream: false,
        },
        {
          signal: abortSignal,
          idempotencyKey: operationId,
          maxRetries: 0,
          timeout: this.timeoutMs,
        },
      );

      if (this.isTerminalFailure(response)) {
        throw this.responseFailure(response);
      }

      return {
        providerOperationId: response.id,
        responsePayload: response,
        metadata: this.metadata(operationType, response),
      };
    } catch (error) {
      throw normalizeOpenAIError(error);
    }
  }

  async getStatus(
    providerOperationId: string,
    operationType: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderStatusResult<OpenAIResponse, OpenAIProviderMetadata>> {
    try {
      const response = await this.client.responses.retrieve(providerOperationId, {
        signal: abortSignal,
        maxRetries: 0,
        timeout: this.timeoutMs,
      });

      const isTerminal = isTerminalStatus(response.status);
      const isSuccess = response.status === 'completed';

      return {
        isTerminal,
        isSuccess,
        responsePayload: response,
        metadata: this.metadata(operationType, response),
        error: isTerminal && !isSuccess ? responseFailureShape(response) : undefined,
      };
    } catch (error) {
      throw normalizeOpenAIError(error);
    }
  }

  async cancel(
    providerOperationId: string,
    _operationType: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.client.responses.cancel(providerOperationId, {
        signal: abortSignal,
        maxRetries: 0,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw normalizeOpenAIError(error);
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

  private metadata(operationType: string, response: OpenAIResponse): OpenAIProviderMetadata {
    return {
      operationType,
      requestId: response._request_id,
      responseStatus: response.status,
      model: response.model,
      usage: response.usage,
    };
  }

  private isTerminalFailure(response: OpenAIResponse): boolean {
    return isTerminalStatus(response.status) && response.status !== 'completed';
  }

  private responseFailure(response: OpenAIResponse): ProviderExecutionError {
    const shape = responseFailureShape(response);
    return new ProviderExecutionError(
      shape.classification,
      shape.code,
      shape.message,
      response,
    );
  }
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'incomplete';
}

function responseFailureShape(response: OpenAIResponse): {
  code: string;
  message: string;
  classification: ProviderErrorClassification;
} {
  const responseError = response.error as { code?: string; message?: string } | null | undefined;
  const code = responseError?.code ?? `OPENAI_RESPONSE_${response.status.toUpperCase()}`;
  const message = responseError?.message ?? `OpenAI response finished with status ${response.status}`;
  return {
    code,
    message,
    classification: classifyOpenAIProviderCode(code, undefined),
  };
}

export function normalizeOpenAIError(error: unknown): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;

  const err = error as {
    name?: string;
    status?: number;
    code?: string;
    type?: string;
    message?: string;
    error?: { code?: string; type?: string; message?: string };
  };

  const status = err.status;
  const providerCode = err.code ?? err.error?.code ?? err.type ?? err.error?.type ?? err.name ?? 'OPENAI_UNKNOWN';
  const message = err.message ?? err.error?.message ?? 'OpenAI request failed';

  return new ProviderExecutionError(
    classifyOpenAIProviderCode(providerCode, status),
    providerCode,
    message,
    error,
    status,
  );
}

function classifyOpenAIProviderCode(code: string, status?: number): ProviderErrorClassification {
  const normalized = code.toLowerCase();

  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    normalized.includes('insufficient_quota') ||
    normalized.includes('billing_hard_limit') ||
    normalized.includes('account_deactivated')
  ) {
    return ProviderErrorClassification.FATAL_P0;
  }

  if (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    normalized.includes('connection') ||
    normalized.includes('timeout') ||
    normalized.includes('rate_limit') ||
    normalized.includes('overloaded') ||
    normalized.includes('abort')
  ) {
    return ProviderErrorClassification.TRANSIENT;
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return ProviderErrorClassification.PERMANENT;
  }

  // Unknown provider failures get the bounded infrastructure retry budget.
  return ProviderErrorClassification.TRANSIENT;
}
