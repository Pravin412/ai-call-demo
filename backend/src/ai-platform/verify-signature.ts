import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

// Checks the X-AI-Platform-Signature header (t=<unix seconds>,v1=<hex HMAC-SHA256>) over the
// exact bytes received. Rejects stale timestamps so a captured request can't be replayed.
export function verifySignature(secret: string, header: string | undefined, rawBody: Buffer | undefined): boolean {
  if (!secret || !header || !rawBody) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const received = Buffer.from(String(parts.v1 ?? ''), 'utf8');
  return received.length === expected.length && timingSafeEqual(received, Buffer.from(expected, 'utf8'));
}
