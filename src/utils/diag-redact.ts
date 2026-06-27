// Defense-in-depth redaction for on-device diagnostic logs (frontend-0028).
//
// The diagnostic buffer is meant to carry ONLY identifiers and metadata
// (serverId, userId, deviceId, roomId, event names, error names/messages,
// timings, booleans, buffer LENGTHS). It must never carry cryptographic
// material or message contents. Two layers guard this:
//
//   1. `redactCtx` — scrubs every string value going INTO an entry, so an
//      accidental key/token/ciphertext passed in `ctx` is neutralised at
//      ingest time.
//   2. `reRedactText` — a final pass over the serialized export, so anything
//      that slipped through the structured layer (e.g. a key embedded in a
//      free-form log line forwarded from the legacy `logger`) is stripped
//      before the file ever leaves the device.
//
// Both layers target the shapes that long crypto material takes: base64 /
// base64url runs, long hex runs, and JWT-like dotted triples.

// JWT: three base64url segments separated by dots (header.payload.signature).
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// Long base64 / base64url run (>=40 chars). Covers identity keys (~44),
// signatures (~88), prekeys, sender keys, encrypted payloads. Includes the
// base64 alphabet plus url-safe variants and trailing padding.
const LONG_B64_RE = /[A-Za-z0-9+/=_-]{40,}/g;

// Long hex run (>=40 chars) — keys/macs sometimes serialise as hex.
const LONG_HEX_RE = /\b[0-9a-fA-F]{40,}\b/g;

function redactToken(match: string): string {
  // Reveal only the length (lengths are explicitly OK to log), never content.
  return `[REDACTED:${match.length}]`;
}

/**
 * Final-pass redactor over arbitrary serialized text. Idempotent and safe to
 * run on an already-redacted string.
 */
export function reRedactText(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT_RE, '[REDACTED:jwt]')
    .replace(LONG_B64_RE, redactToken)
    .replace(LONG_HEX_RE, redactToken);
}

type CtxValue = string | number | boolean | null | undefined;
export type DiagCtx = Record<string, CtxValue>;

/**
 * Scrub a context object on the way into the buffer. Numbers/booleans/null
 * pass through untouched (they are the identifiers/metadata we want). String
 * values are pushed through the token redactor so an accidental key/token is
 * neutralised at ingest. Non-primitive values are coerced to a redacted
 * string rather than recursively serialised — `ctx` is contractually flat.
 */
export function redactCtx(ctx: DiagCtx | undefined): DiagCtx | undefined {
  if (!ctx) return undefined;
  const out: DiagCtx = {};
  for (const key of Object.keys(ctx)) {
    const v = ctx[key];
    if (v == null || typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    } else if (typeof v === 'string') {
      out[key] = reRedactText(v);
    } else {
      out[key] = reRedactText(String(v));
    }
  }
  return out;
}
