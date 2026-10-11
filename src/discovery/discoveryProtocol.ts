import type { DiscoveryInput, DiscoveryResult } from '../core/projectSpec';

/** Production discovery inputs contain data only; injected test hooks stay in the core API. */
export type WorkerDiscoveryInput = Omit<DiscoveryInput, 'fs' | 'resolve' | 'exec'>;

export interface DiscoveryExecutor {
  /** Starts a registry refresh; a failed worker stays bypassed for both discovery passes. */
  beginRefresh(): void;
  discover(input: WorkerDiscoveryInput): Promise<DiscoveryResult>;
  dispose(): void;
}

export interface DiscoveryRequest {
  id: number;
  input: WorkerDiscoveryInput;
}

export type DiscoveryReply =
  | { id: number; result: DiscoveryResult; nodeVersionCacheEntries: Array<[string, string | null]> }
  | { id: number; error: { message: string; stack?: string } };
