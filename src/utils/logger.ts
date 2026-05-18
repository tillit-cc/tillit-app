import { useAppStore } from '@/stores/app.store';

// Diagnostic logs into the Zustand store (visible via 10-tap in ServerStatusModal)
// are only collected when running a dev build, or when the build opts in
// explicitly via EXPO_PUBLIC_ENABLE_DIAG_LOGS=true. In release the Zustand sink
// is a no-op so a forensics dump cannot reveal connection metadata.
const STORE_LOGGING_ENABLED =
  __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DIAG_LOGS === 'true';

// Keys that may carry tokens, keys, or ciphertext. Matched case-insensitively
// on the whole key name. Anything matching is redacted before stringification
// so the diagnostic log (visible in ServerStatusModal) never leaks credentials.
const REDACT_KEYS = [
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'api_key',
  'bearer',
  'password',
  'passcode',
  'secret',
  'privatekey',
  'private_key',
  'identitykey',
  'identitypublickey',
  'encryptedbody',
  'ciphertext',
  'plaintext',
  'fingerprint',
  'safetynumber',
  'mac',
  'signature',
  'sessionkey',
  'senderkey',
  'distributionid',
  'prekey',
  'signedprekey',
  'kyberprekey',
  'mediakey',
];

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEYS.includes(k);
}

function sanitize(value: any, depth = 0, seen = new WeakSet<object>()): any {
  if (value == null || depth > 6) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(v => sanitize(v, depth + 1, seen));
  }

  // Skip non-plain objects (Error preserves stack/message; Headers, etc.)
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, any> = {};
  for (const k of Object.keys(value)) {
    out[k] = shouldRedact(k) ? '[REDACTED]' : sanitize(value[k], depth + 1, seen);
  }
  return out;
}

function safeStringify(arg: any): string {
  try {
    return JSON.stringify(sanitize(arg));
  } catch {
    return '[Unserializable]';
  }
}

function write(level: 'log' | 'warn' | 'error', ...args: any[]) {
  // Always log to console
  console[level](...args);

  if (!STORE_LOGGING_ENABLED) return;

  // Format message for store, redacting sensitive fields
  const msg = args
    .map(a => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');

  try {
    useAppStore.getState().addConnectionLog(msg);
  } catch {
    // Store not ready yet — ignore
  }
}

export const logger = {
  info: (...args: any[]) => write('log', ...args),
  warn: (...args: any[]) => write('warn', ...args),
  error: (...args: any[]) => write('error', ...args),
};
