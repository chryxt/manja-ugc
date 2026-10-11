import {
  DatabaseError,
  ExecutionClaimError,
  FinancialInvariantError,
  InvalidTransitionError,
  JobNotFoundError,
} from '../db/errors';
import { ProviderErrorClassification, ProviderExecutionError } from '../providers/types';

export type WorkerErrorDisposition = 'retry' | 'terminal-failure' | 'operational-stop';

export interface WorkerErrorDecision {
  disposition: WorkerErrorDisposition;
  code: string;
  message: string;
}

interface ProviderLikeError {
  code?: string;
  message?: string;
  retryable?: boolean;
  status?: number;
  statusCode?: number;
}

const RETRYABLE_DB_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const TERMINAL_PROVIDER_CODES = new Set([
  'INVALID_INPUT',
  'ASSET_MISSING',
  'UNSUPPORTED_JOB_TYPE',
  'POLICY_REJECTED',
  'CONTENT_REJECTED',
]);

export function classifyWorkerError(error: unknown): WorkerErrorDecision {
  const err = error as ProviderLikeError;
  const message = err?.message ?? (error instanceof Error ? error.message : String(error));
  const code = err?.code ?? 'WORKER_UNKNOWN';

  // Financial/data invariants are incidents. The worker must not attempt compensating
  // ledger mutations or silently turn them into ordinary job failures.
  if (error instanceof FinancialInvariantError) {
    return { disposition: 'operational-stop', code: error.code, message: error.message };
  }

  // Missing authoritative job data is a queue/orchestration incident, not a provider retry.
  if (error instanceof JobNotFoundError) {
    return { disposition: 'operational-stop', code: error.code, message: error.message };
  }

  // A competing worker currently owns the execution lease. Retrying the same BullMQ
  // delivery later is safe; this is not a business retry and must not create a new DB job.
  if (error instanceof ExecutionClaimError) {
    return { disposition: 'retry', code: error.code, message: error.message };
  }

  // Transition conflicts generally mean authoritative state changed underneath the worker.
  // Do not keep hammering the state machine automatically.
  if (error instanceof InvalidTransitionError) {
    return { disposition: 'operational-stop', code: error.code, message: error.message };
  }

  if (error instanceof DatabaseError) {
    if (RETRYABLE_DB_CODES.has(error.code) || error.code.startsWith('08')) {
      return { disposition: 'retry', code: error.code, message: error.message };
    }
    return { disposition: 'operational-stop', code: error.code, message: error.message };
  }

  if (error instanceof ProviderExecutionError) {
    if (error.classification === ProviderErrorClassification.TRANSIENT) {
      return { disposition: 'retry', code: error.providerCode, message: error.message };
    }
    if (error.classification === ProviderErrorClassification.PERMANENT) {
      return { disposition: 'terminal-failure', code: error.providerCode, message: error.message };
    }
    return { disposition: 'operational-stop', code: error.providerCode, message: error.message };
  }

  const status = err?.statusCode ?? err?.status;
  if (
    err?.retryable === true ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return { disposition: 'retry', code, message };
  }

  if (TERMINAL_PROVIDER_CODES.has(code) || (status !== undefined && status >= 400 && status < 500)) {
    return { disposition: 'terminal-failure', code, message };
  }

  // Unknown failures receive the bounded BullMQ infrastructure retry budget. If they keep
  // failing, BullMQ exhausts attempts rather than creating a paid retry lineage entry.
  return { disposition: 'retry', code, message };
}
