export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class JobNotFoundError extends DatabaseError {
  constructor(jobId: string, cause?: unknown) {
    super(`Job ${jobId} not found or unavailable`, 'P0002', cause);
    this.name = 'JobNotFoundError';
  }
}

export class InvalidTransitionError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, '22023', cause);
    this.name = 'InvalidTransitionError';
  }
}

export class IdempotencyConflictError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, '22023', cause);
    this.name = 'IdempotencyConflictError';
  }
}

export class FinancialInvariantError extends DatabaseError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, cause);
    this.name = 'FinancialInvariantError';
  }
}

export class ExecutionClaimError extends DatabaseError {
  constructor(message: string, cause?: unknown) {
    super(message, '55P03', cause);
    this.name = 'ExecutionClaimError';
  }
}

export interface PgLikeError {
  code?: string;
  message?: string;
}

export function mapDatabaseError(error: unknown, jobId?: string): never {
  const err = error as PgLikeError;
  const code = err?.code ?? 'DB_UNKNOWN';
  const message = err?.message ?? 'Unknown database error';
  const lower = message.toLowerCase();

  if (code === '55P03') {
    throw new ExecutionClaimError(message, error);
  }

  if (code === 'P0002' && lower.includes('job')) {
    throw new JobNotFoundError(jobId ?? 'unknown', error);
  }

  if (code === '22023' && lower.includes('transition')) {
    throw new InvalidTransitionError(message, error);
  }

  if (code === '22023' && lower.includes('idempot')) {
    throw new IdempotencyConflictError(message, error);
  }

  if (
    lower.includes('reservation') ||
    lower.includes('credit account') ||
    lower.includes('reserved credits') ||
    lower.includes('balance')
  ) {
    throw new FinancialInvariantError(message, code, error);
  }

  throw new DatabaseError(message, code, error);
}
