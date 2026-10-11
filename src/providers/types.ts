import type { AIProvider as DBProviderEnum } from '../db/job-rpc';

export enum ProviderErrorClassification {
  TRANSIENT = 'TRANSIENT',
  PERMANENT = 'PERMANENT',
  FATAL_P0 = 'FATAL_P0',
}

export class ProviderExecutionError extends Error {
  constructor(
    public readonly classification: ProviderErrorClassification,
    public readonly providerCode: string,
    message: string,
    public readonly rawError?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
  }
}

export interface ProviderRequestMetadata {
  jobId: string;
  operationId: string;
  workspaceId: string;
}

export interface ProviderAdapterCapabilities {
  externalIdempotency: boolean;
  asyncStatus: boolean;
  cancellation: 'none' | 'background-only' | 'supported';
}

export interface ProviderSubmissionResult<TResponse = unknown, TMetadata = unknown> {
  providerOperationId: string;
  responsePayload?: TResponse;
  metadata: TMetadata;
}

export interface ProviderStatusResult<TResponse = unknown, TMetadata = unknown> {
  isTerminal: boolean;
  isSuccess: boolean;
  responsePayload?: TResponse;
  metadata: TMetadata;
  error?: {
    code: string;
    message: string;
    classification: ProviderErrorClassification;
  };
}

export interface IAIProviderAdapter<TPayload = unknown, TResponse = unknown, TMetadata = unknown> {
  readonly providerName: DBProviderEnum;
  readonly capabilities: ProviderAdapterCapabilities;

  submit(
    operationId: string,
    operationType: string,
    payload: TPayload,
    context: ProviderRequestMetadata,
    abortSignal?: AbortSignal,
  ): Promise<ProviderSubmissionResult<TResponse, TMetadata>>;

  getStatus(
    providerOperationId: string,
    operationType: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderStatusResult<TResponse, TMetadata>>;

  cancel?(
    providerOperationId: string,
    operationType: string,
    abortSignal?: AbortSignal,
  ): Promise<void>;
}
