/**
 * Domain separator for auth challenges. Prepended to the server-supplied
 * nonce before signing, so the identity key signature can never be confused
 * with a SignedPreKey / KyberPreKey signature (which use the same key).
 *
 * Server must verify the signature against the exact same byte sequence:
 *   utf8("TilliT-Auth-Challenge-v1\n" + serverHost + "\n") || nonceBytes
 *
 * Bumping the version is a breaking change between client and server.
 */
export const CHALLENGE_DOMAIN = 'TilliT-Auth-Challenge-v1';

/**
 * Build the base64-encoded message the client signs for challenge-response auth.
 * Concatenates a UTF-8 domain prefix with the raw nonce bytes, then base64-encodes
 * the result so the native bridge can decode it and feed it to libsignal's
 * `generateSignature` / `calculateSignature`.
 */
export function buildChallengeMessageBase64(nonceBase64: string, baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  const prefix = `${CHALLENGE_DOMAIN}\n${host}\n`;
  const prefixBytes = new TextEncoder().encode(prefix);

  const nonceBinary = atob(nonceBase64);
  const nonceBytes = new Uint8Array(nonceBinary.length);
  for (let i = 0; i < nonceBinary.length; i++) {
    nonceBytes[i] = nonceBinary.charCodeAt(i);
  }

  const combined = new Uint8Array(prefixBytes.length + nonceBytes.length);
  combined.set(prefixBytes, 0);
  combined.set(nonceBytes, prefixBytes.length);

  let binary = '';
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  return btoa(binary);
}
