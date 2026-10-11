/** Runs the unchanged synchronous discovery passes away from the extension-host event loop. */
import { parentPort } from 'worker_threads';
import { discoverProjectsAsync } from '../core/projectSpec';
import type { DiscoveryReply, DiscoveryRequest } from './discoveryProtocol';

if (!parentPort) throw new Error('Discovery worker requires a parent port');
const port = parentPort;

port.on('message', async (request: DiscoveryRequest) => {
  const cache = request.input.nodeVersionCache ?? new Map<string, string | null>();
  try {
    const result = await discoverProjectsAsync({ ...request.input, nodeVersionCache: cache });
    port.postMessage({ id: request.id, result, nodeVersionCacheEntries: [...cache] } satisfies DiscoveryReply);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    port.postMessage({ id: request.id, error: { message: error.message, stack: error.stack } } satisfies DiscoveryReply);
  }
});
