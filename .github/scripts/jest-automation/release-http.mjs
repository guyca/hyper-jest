import { setTimeout as sleep } from 'node:timers/promises';

export class ReleaseDeadlineExceeded extends Error {
  constructor() { super('Release verification deadline exceeded.'); }
}

// Callers opt in only for reads (including the Marketplace's POST query).
// Retrying a publish, release creation, or upload could duplicate a side effect.
export async function releaseRequest(url, options, {
  label, fetcher = fetch, wait = sleep, timeout = 120_000,
  retry = false, missing = false, decode = response => response.json(),
  remainingTime = () => Infinity,
}) {
  const attempts = retry ? 3 : 1;
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(url, { ...options, signal: AbortSignal.timeout(Math.min(timeout, remainingTime())) });
      remainingTime();
      if (missing && response.status === 404) return null;
      if (response.ok) {
        const result = response.status === 204 ? null : await decode(response);
        remainingTime();
        return result;
      }
    } catch (error) {
      if (error instanceof ReleaseDeadlineExceeded) throw error;
      remainingTime();
      // Fetch errors can contain credentials or signed redirect URLs. Log only
      // a bounded error code and the caller's safe operation label.
      const code = error.cause?.code ?? error.code ?? error.name;
      failure = /^[A-Z_0-9]+$/i.test(code ?? '') ? code : 'transport error';
    }
    if (response && !response.ok) {
      failure = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`${label} failed (${failure}).`);
      }
    }
    if (attempt < attempts) {
      await wait(Math.min(1000 * attempt, remainingTime()));
      remainingTime();
    }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s) (${failure}).`);
}
