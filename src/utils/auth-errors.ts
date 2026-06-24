/**
 * ADR-0010 / ADR-0011 — per-device server-auth credential. Single source of
 * truth for detecting the server-auth error codes the backend returns from
 * `POST /auth/identity` and `POST /keys`. See
 * `_shared/api/per-device-server-auth.md`.
 *
 * The backend encodes the machine-readable code in `response.data.error`
 * (same shape as `BANNED`), with the HTTP status carrying the coarse class.
 *
 * ADR-0011 removed the primary-recovery flow entirely: there is no
 * `recoverPrimary` flag, no recovery-scoped JWT, and the `RECOVERY_*` /
 * `PRIMARY_RECOVERY_NOT_NEEDED` codes no longer exist. Losing the primary's
 * device-auth key is unrecoverable server-side → the user recreates the
 * account. ADR-0011 also added `PRIMARY_INACTIVE` (liveness lock).
 */

export const DEVICE_AUTH_INVALID = 'DEVICE_AUTH_INVALID';
export const DEVICE_AUTH_REQUIRED = 'DEVICE_AUTH_REQUIRED';
export const DEVICE_AUTH_MISMATCH = 'DEVICE_AUTH_MISMATCH';

// ADR-0011 liveness lock: a linked device (deviceId !== 1) tried to enter
// (login / WebSocket connect) while the primary has been idle past the
// server threshold. Reversible — NOT a logout/revoke.
export const PRIMARY_INACTIVE = 'PRIMARY_INACTIVE';

/** Extract the backend machine error code (`response.data.error`), if any. */
export function getServerErrorCode(error: any): string | null {
  const code = error?.response?.data?.error;
  return typeof code === 'string' ? code : null;
}

/**
 * 401 at login because this device has a registered device-auth key but the
 * `deviceAuthSignature` was missing or didn't verify. In practice this means
 * the device-auth key on the server no longer matches the one this device
 * holds (e.g. it was lost on reinstall). There is no recovery (ADR-0011): on
 * the primary the only cure is to recreate the account; a linked device must
 * be re-paired.
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
 * already-bound `(userId, deviceId)`. There is no override (ADR-0011): the
 * device regenerated its key while the server still has the old one bound.
 * On the primary this means the account must be recreated; a linked device
 * must be re-paired.
 */
export function isDeviceAuthMismatchError(error: any): boolean {
  return error?.response?.status === 409 && getServerErrorCode(error) === DEVICE_AUTH_MISMATCH;
}

/**
 * 401 `PRIMARY_INACTIVE` (ADR-0011 liveness lock). A linked device tried to
 * authenticate while the primary device has been idle past the server's
 * threshold. This is TEMPORARY and REVERSIBLE — the linked device is not
 * revoked. As soon as the primary comes back online the lock clears and the
 * linked device can sign in again without re-pairing. Callers must surface a
 * "reconnect your primary device" message, NOT a logout.
 */
export function isPrimaryInactiveError(error: any): boolean {
  return error?.response?.status === 401 && getServerErrorCode(error) === PRIMARY_INACTIVE;
}
