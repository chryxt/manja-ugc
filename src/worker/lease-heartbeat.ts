import type { ExecutionLease, JobRPC } from '../db/job-rpc';

export interface LeaseHeartbeatOptions {
  ttlSeconds?: number;
  intervalMs?: number;
}

export class LeaseHeartbeat {
  readonly abortController = new AbortController();

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failure: unknown = null;

  constructor(
    private readonly rpc: JobRPC,
    private readonly lease: ExecutionLease,
    private readonly options: LeaseHeartbeatOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;

    const ttlSeconds = this.options.ttlSeconds ?? 60;
    const intervalMs = this.options.intervalMs ?? Math.max(5_000, Math.floor((ttlSeconds * 1_000) / 3));

    this.timer = setInterval(() => {
      void this.tick(ttlSeconds);
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait briefly for an in-flight heartbeat to settle through the event loop.
    while (this.inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  assertHealthy(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  private async tick(ttlSeconds: number): Promise<void> {
    if (this.inFlight || this.failure) return;
    this.inFlight = true;

    try {
      await this.rpc.renewExecutionLease(this.lease, ttlSeconds);
    } catch (error) {
      this.failure = error;
      this.abortController.abort(error);
    } finally {
      this.inFlight = false;
    }
  }
}
