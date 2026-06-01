/**
 * ADR-0010 — per-device server-auth credential. Single source of truth for
 * detecting the server-auth error codes the backend returns from
 * `POST /auth/identity` and `POST /keys`. See
 * `_shared/api/per-device-server-auth.md`.
 *
 * The backend encodes the machine-readable code in `response.data.error`
 * (same shape as `BANNED`), with the HTTP status carrying the coarse class.
 */

export const DEVICE_AUTH_INVALID = 'DEVICE_AUTH_INVALID';
export const DEVICE_AUTH_REQUIRED = 'DEVICE_AUTH_REQUIRED';
export const DEVICE_AUTH_MISMATCH = 'DEVICE_AUTH_MISMATCH';

// Primary-recovery flow error codes (ADR-0010 OQ-1).
export const RECOVERY_PRIMARY_ONLY = 'RECOVERY_PRIMARY_ONLY';
export const RECOVERY_REQUIRES_EXISTING_USER = 'RECOVERY_REQUIRES_EXISTING_USER';
export const PRIMARY_RECOVERY_NOT_NEEDED = 'PRIMARY_RECOVERY_NOT_NEEDED';
export const RECOVERY_TOKEN_DENIED = 'RECOVERY_TOKEN_DENIED';
export const RECOVERY_PAYLOAD_REQUIRED = 'RECOVERY_PAYLOAD_REQUIRED';

/** Extract the backend machine error code (`response.data.error`), if any. */
export function getServerErrorCode(error: any): string | null {
  const code = error?.response?.data?.error;
  return typeof code === 'string' ? code : null;
}

/**
 * 401 at login because this device has a registered device-auth key but the
 * `deviceAuthSignature` was missing or didn't verify. In practice this means
 * the device-auth key on the server no longer matches the one this device
 * holds (e.g. it was lost and lazily regenerated) → the device must re-setup
 * (primary recovery) or be re-paired (linked).
 */
export function isDeviceAuthInvalidError(error: any): boolean {
  return error?.response?.status === 401 && getServerErrorCode(error) === DEVICE_AUTH_INVALID;
}

/**
 * 401 at login because `DEVICE_AUTH_REQUIRED=true` server-side and this device
 * has no registered device-auth key yet. The device must register one (upload
 * its bundle via `POST /keys`) before it can authenticate.
 */
export function isDeviceAuthRequiredError(error: any): boolean {
  return error?.response?.status === 401 && getServerErrorCode(error) === DEVICE_AUTH_REQUIRED;
}

/** Either device-auth login failure (invalid or required). */
export function isDeviceAuthError(error: any): boolean {
  return isDeviceAuthInvalidError(error) || isDeviceAuthRequiredError(error);
}

/**
 * 409 at `POST /keys` — attempt to re-bind a DIFFERENT device-auth key to an
 * already-bound `(userId, deviceId)` without `recoverPrimary`. Indicates the
 * device regenerated its key while the server still has the old one bound;
 * surfaced for diagnostics (the legitimate cure is the primary-recovery flow).
 */
export function isDeviceAuthMismatchError(error: any): boolean {
  return error?.response?.status === 409 && getServerErrorCode(error) === DEVICE_AUTH_MISMATCH;
}

/**
 * 409 at the recovery login: the device has NO auth key bound server-side, so
 * the deadlock recovery isn't needed — plain transition-mode login already
 * works. The recovery orchestrator catches this and falls back to a normal
 * login (which then TOFU-binds the key via `POST /keys`).
 */
export function isPrimaryRecoveryNotNeededError(error: any): boolean {
  return error?.response?.status === 409 && getServerErrorCode(error) === PRIMARY_RECOVERY_NOT_NEEDED;
}
