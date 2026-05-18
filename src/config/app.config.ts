/**
 * App configuration
 * Values can be overridden via environment variables (EXPO_PUBLIC_*)
 */

/**
 * Signal Protocol device id of the primary device.
 *
 * By convention (Signal, WhatsApp, libsignal docs), the primary device is
 * always assigned id = 1. Linked / secondary devices receive their own id
 * from the server during the pairing flow (see
 * `_shared/api/multi-device-linking.md` for the future spec).
 *
 * TilliT is single-device today: every install registers as the primary,
 * uploads its public bundle with deviceId=1, and the backend stores the
 * record with the same value. JWT claims include `deviceId` which is
 * cross-validated against the bundle on key uploads.
 *
 * When multi-device is enabled, this constant remains correct for the
 * primary — only linked devices will use a different id, received from
 * the backend at pairing time. Do NOT hardcode `1` anywhere else: import
 * this constant so the single source of truth is here.
 */
export const PRIMARY_DEVICE_ID = 1;

/**
 * Sender key threshold: minimum number of room members before
 * switching from pair-wise encryption to sender key encryption.
 * Default: 4 (use sender keys for rooms with 4+ members)
 */
export const SENDER_KEY_THRESHOLD = parseInt(
  process.env.EXPO_PUBLIC_SENDER_KEY_THRESHOLD || '4',
  10
);

/**
 * Sender key rotation thresholds
 */
export const SENDER_KEY_MESSAGE_ROTATION_THRESHOLD = parseInt(
  process.env.EXPO_PUBLIC_SENDER_KEY_MESSAGE_ROTATION || '1000',
  10
);

export const SENDER_KEY_ROTATION_THRESHOLD_SECONDS = parseInt(
  process.env.EXPO_PUBLIC_SENDER_KEY_DAYS_ROTATION || '7',
  10
) * 24 * 60 * 60; // Convert days to seconds

/** @deprecated Use SENDER_KEY_ROTATION_THRESHOLD_SECONDS instead */
export const SENDER_KEY_DAYS_ROTATION_THRESHOLD = SENDER_KEY_ROTATION_THRESHOLD_SECONDS;

/**
 * Chat pagination settings
 */

export const PAGE_SIZE = parseInt(process.env.EXPO_PUBLIC_PAGE_SIZE || '35', 10);

/**
 * Ephemeral image settings
 */
export const EPHEMERAL_DURATIONS = [5, 10, 30] as const;
export const EPHEMERAL_DEFAULT_DURATION = 10;
export const EPHEMERAL_TTL_OPTIONS = [1, 6, 12, 24] as const;
export const EPHEMERAL_DEFAULT_TTL_HOURS = 24;

/**
 * Typing indicator thresholds
 */
export const TYPING_THROTTLE_MS = 3000;
export const TYPING_EXPIRE_MS = 4000;
export const TYPING_CLEANUP_INTERVAL_MS = 2000;
