import { reRedactText, redactCtx } from './diag-redact';

// Realistic-shaped secrets the diagnostic export must NEVER contain.
const IDENTITY_KEY_B64 = 'BWj3kS9xQ2pLm4nR7tVcXz0aB1cD2eF3gH4iJ5kL6mN'; // ~44 base64 chars
const SIGNATURE_B64 =
  'MEUCIQDx8aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aAIgB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6a'; // ~92 chars
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
const HEX_KEY = 'a3f1c9e7b2d48506a3f1c9e7b2d48506a3f1c9e7b2d48506'; // 48 hex chars

describe('reRedactText', () => {
  it('strips base64 identity keys', () => {
    const out = reRedactText(`identity=${IDENTITY_KEY_B64} ok`);
    expect(out).not.toContain(IDENTITY_KEY_B64);
    expect(out).toMatch(/\[REDACTED:\d+\]/);
  });

  it('strips long base64 signatures', () => {
    expect(reRedactText(SIGNATURE_B64)).not.toContain(SIGNATURE_B64);
  });

  it('strips JWT bearer tokens', () => {
    expect(reRedactText(`Authorization: Bearer ${JWT}`)).not.toContain(JWT);
  });

  it('strips long hex keys', () => {
    expect(reRedactText(HEX_KEY)).not.toContain(HEX_KEY);
  });

  it('preserves identifiers and short metadata', () => {
    const line = 'serverId=3 userId=42 deviceId=2 roomId=1007 event=auth.ok durMs=812';
    expect(reRedactText(line)).toBe(line);
  });

  it('is idempotent', () => {
    const once = reRedactText(`k=${IDENTITY_KEY_B64}`);
    expect(reRedactText(once)).toBe(once);
  });
});

describe('redactCtx', () => {
  it('passes identifiers through untouched', () => {
    expect(redactCtx({ serverId: 3, userId: 42, ok: true, name: null })).toEqual({
      serverId: 3,
      userId: 42,
      ok: true,
      name: null,
    });
  });

  it('redacts a key accidentally placed in ctx', () => {
    const out = redactCtx({ serverId: 1, leaked: IDENTITY_KEY_B64 })!;
    expect(out.serverId).toBe(1);
    expect(out.leaked).not.toContain(IDENTITY_KEY_B64);
  });

  it('returns undefined for undefined input', () => {
    expect(redactCtx(undefined)).toBeUndefined();
  });
});

// Anti-leak guard required by the acceptance criteria: a representative export
// blob must not contain any long base64/hex/JWT token in plaintext.
describe('export anti-leak guard', () => {
  it('a sample export contains no unredacted crypto-shaped tokens', () => {
    const sampleExport = [
      '# TilliT diagnostics export',
      JSON.stringify({ ts: 1, level: 'error', category: 'session', event: 'mismatch', ctx: redactCtx({ serverId: 2, userId: 9, deviceId: 1, roomId: 1003, key: IDENTITY_KEY_B64 }) }),
      JSON.stringify({ ts: 2, level: 'info', category: 'auth', event: 'token', ctx: redactCtx({ serverId: 2, jwt: JWT }) }),
      `raw line with embedded signature ${SIGNATURE_B64} and hex ${HEX_KEY}`,
    ].join('\n');

    const cleaned = reRedactText(sampleExport);
    for (const secret of [IDENTITY_KEY_B64, SIGNATURE_B64, JWT, HEX_KEY]) {
      expect(cleaned).not.toContain(secret);
    }
    // Sanity: any base64/hex run of 40+ chars left over would be a leak.
    expect(cleaned).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
  });
});
