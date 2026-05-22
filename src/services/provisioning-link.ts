/**
 * Pure helpers for the multi-device pairing QR (wire v2).
 *
 * Kept separate from `device.service.ts` because they are:
 *
 *   - dependency-free (no native modules, no axios, no Tor proxy chain)
 *     so Jest can import them in tests without dragging the ESM-only
 *     `tor-proxy` module through the transform pipeline.
 *   - referentially transparent: pure functions over strings/buffers.
 *
 * Spec: `_shared/api/multi-device-linking.md` (v2).
 */

import { Buffer } from 'buffer';
import { logger } from '@/utils/logger';
import type { ProvisioningLinkParams } from '@/types/device';

/** Wire protocol version of the QR. Bumped from v1 with the pairing direction flip (ADR-0003). */
export const QR_PROTOCOL_VERSION = 2;

/**
 * Build the v=2 provisioning URL. Embeds `serverOrigin` and `E_pub` in
 * base64url so the QR is URL-safe.
 *
 * `ephemeralPublicKey` is expected in standard base64 (with/without
 * padding), as emitted by the native `generateProvisioningKeypair`.
 */
export function buildProvisioningUrlV2(params: {
  sessionId: string;
  serverOrigin: string;
  ephemeralPublicKey: string;
}): string {
  const s = utf8ToBase64url(params.serverOrigin);
  const e = base64ToBase64url(params.ephemeralPublicKey);
  return `tillit://link?v=${QR_PROTOCOL_VERSION}&i=${params.sessionId}&s=${s}&e=${e}`;
}

/**
 * Parse a `tillit://link?v=2&i=<sessionId>&s=<base64url(server)>&e=<base64url(E_pub)>`
 * URL into structured params. Strict validation:
 *
 * - Rejects v ≠ 2 (v1 is deprecated and never reached production).
 * - Requires all four fields (`v`, `i`, `s`, `e`).
 * - Requires `s` to decode to a valid http(s)/tor URL.
 * - Requires `e` to decode to a 32-byte X25519 public key.
 *
 * Returns null if any check fails.
 */
export function parseProvisioningLinkV2(url: string): ProvisioningLinkParams | null {
  try {
    const m = url.match(/^tillit:\/\/link\?(.+)$/);
    if (!m) {
      logger.warn('[ProvisioningLink] parse reject: not a tillit://link URL. Got:', url?.slice(0, 80));
      return null;
    }
    const params = new URLSearchParams(m[1]);
    const v = parseInt(params.get('v') ?? '0', 10);
    const sessionId = params.get('i') ?? '';
    const sEncoded = params.get('s');
    const eEncoded = params.get('e');
    if (v !== QR_PROTOCOL_VERSION) {
      logger.warn(`[ProvisioningLink] parse reject: bad version ${v} (expected ${QR_PROTOCOL_VERSION})`);
      return null;
    }
    if (!sessionId || !sEncoded || !eEncoded) {
      logger.warn('[ProvisioningLink] parse reject: missing field(s)', {
        hasSessionId: !!sessionId,
        hasS: !!sEncoded,
        hasE: !!eEncoded,
      });
      return null;
    }

    const serverOrigin = base64urlToUtf8(sEncoded);
    if (!serverOrigin) {
      logger.warn('[ProvisioningLink] parse reject: s base64url decode failed');
      return null;
    }
    if (!/^(https?:\/\/)/i.test(serverOrigin)) {
      logger.warn('[ProvisioningLink] parse reject: serverOrigin not http(s):', serverOrigin);
      return null;
    }

    const newDeviceEphemeralPub = base64urlToBase64(eEncoded);
    if (!newDeviceEphemeralPub || !isLikely32ByteBase64(newDeviceEphemeralPub)) {
      logger.warn('[ProvisioningLink] parse reject: e is not a 32-byte X25519 key', {
        eEncodedLen: eEncoded.length,
        decodedB64Len: newDeviceEphemeralPub?.length ?? 0,
      });
      return null;
    }

    return {
      v: QR_PROTOCOL_VERSION,
      sessionId,
      serverOrigin,
      newDeviceEphemeralPub,
    };
  } catch (err) {
    logger.warn('[ProvisioningLink] parse failed:', err);
    return null;
  }
}

/**
 * Compare two server origins for equality. Tolerates trailing slashes
 * and case differences in scheme/host but otherwise requires identical
 * origin (no path / query / fragment differences). Onion URLs are
 * handled the same way — they're just http(s) URLs with a `.onion` host.
 */
export function originsMatch(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const url = new URL(u);
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
    } catch {
      return u.replace(/\/+$/, '').toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

// ===================== INTERNAL HELPERS =====================

function utf8ToBase64url(s: string): string {
  return base64ToBase64url(Buffer.from(s, 'utf8').toString('base64'));
}

function base64urlToUtf8(s: string): string | null {
  try {
    const b64 = base64urlToBase64(s);
    if (!b64) return null;
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function base64ToBase64url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlToBase64(b64url: string): string {
  let s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad === 1) return ''; // invalid length
  return s;
}

/**
 * Sanity check: an X25519 public key is 32 bytes, which in standard
 * base64 is 44 chars including one `=` of padding. We accept 43 or 44
 * (with/without padding).
 */
function isLikely32ByteBase64(b64: string): boolean {
  return b64.length === 44 || b64.length === 43;
}
