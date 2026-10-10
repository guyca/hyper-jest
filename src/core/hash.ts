/** Small hashing helpers shared by discovery (stable project ids) and parsers (content hashes). Pure. */
import { createHash } from 'crypto';

/** Hex sha1 of a string or buffer. */
export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Short (12 hex chars by default) sha1 prefix for display-friendly ids. */
export function sha1Short(input: string | Buffer, length = 12): string {
  return sha1(input).slice(0, length);
}

/** Deterministic hash of several parts; parts are NUL-joined so `["ab","c"]` differs from `["a","bc"]`. */
export function hashParts(parts: readonly (string | undefined)[]): string {
  return sha1(parts.map(p => p ?? '').join('\0'));
}
