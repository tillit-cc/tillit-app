import {
  getServerErrorCode,
  isDeviceAuthInvalidError,
  isDeviceAuthRequiredError,
  isDeviceAuthError,
  isDeviceAuthMismatchError,
  isPrimaryInactiveError,
} from './auth-errors';

/** Build an Axios-shaped error with a given status + backend error code. */
const httpError = (status: number, code?: string) => ({
  response: { status, data: code ? { error: code } : {} },
});

describe('auth-errors (ADR-0010 device-auth error detection)', () => {
  describe('getServerErrorCode', () => {
    it('extracts the backend error code', () => {
      expect(getServerErrorCode(httpError(401, 'DEVICE_AUTH_INVALID'))).toBe('DEVICE_AUTH_INVALID');
    });
    it('returns null when absent or non-string', () => {
      expect(getServerErrorCode(httpError(401))).toBeNull();
      expect(getServerErrorCode({})).toBeNull();
      expect(getServerErrorCode(new Error('boom'))).toBeNull();
      expect(getServerErrorCode(undefined)).toBeNull();
    });
  });

  describe('isDeviceAuthInvalidError', () => {
    it('matches 401 + DEVICE_AUTH_INVALID', () => {
      expect(isDeviceAuthInvalidError(httpError(401, 'DEVICE_AUTH_INVALID'))).toBe(true);
    });
    it('rejects wrong status or wrong code', () => {
      expect(isDeviceAuthInvalidError(httpError(403, 'DEVICE_AUTH_INVALID'))).toBe(false);
      expect(isDeviceAuthInvalidError(httpError(401, 'DEVICE_AUTH_REQUIRED'))).toBe(false);
      expect(isDeviceAuthInvalidError(httpError(401, 'BANNED'))).toBe(false);
    });
  });

  describe('isDeviceAuthRequiredError', () => {
    it('matches 401 + DEVICE_AUTH_REQUIRED', () => {
      expect(isDeviceAuthRequiredError(httpError(401, 'DEVICE_AUTH_REQUIRED'))).toBe(true);
      expect(isDeviceAuthRequiredError(httpError(401, 'DEVICE_AUTH_INVALID'))).toBe(false);
    });
  });

  describe('isDeviceAuthError', () => {
    it('matches either INVALID or REQUIRED at 401', () => {
      expect(isDeviceAuthError(httpError(401, 'DEVICE_AUTH_INVALID'))).toBe(true);
      expect(isDeviceAuthError(httpError(401, 'DEVICE_AUTH_REQUIRED'))).toBe(true);
    });
    it('does not match MISMATCH (that is a 409, not a login failure)', () => {
      expect(isDeviceAuthError(httpError(409, 'DEVICE_AUTH_MISMATCH'))).toBe(false);
    });
    it('does not match unrelated errors', () => {
      expect(isDeviceAuthError(httpError(401, 'BANNED'))).toBe(false);
      expect(isDeviceAuthError(httpError(500))).toBe(false);
    });
  });

  describe('isDeviceAuthMismatchError', () => {
    it('matches 409 + DEVICE_AUTH_MISMATCH', () => {
      expect(isDeviceAuthMismatchError(httpError(409, 'DEVICE_AUTH_MISMATCH'))).toBe(true);
    });
    it('rejects 401 + DEVICE_AUTH_MISMATCH (wrong status) and other 409s', () => {
      expect(isDeviceAuthMismatchError(httpError(401, 'DEVICE_AUTH_MISMATCH'))).toBe(false);
      expect(isDeviceAuthMismatchError(httpError(409, 'CONFLICT'))).toBe(false);
    });
  });

  describe('isPrimaryInactiveError (ADR-0011 liveness lock)', () => {
    it('matches 401 + PRIMARY_INACTIVE', () => {
      expect(isPrimaryInactiveError(httpError(401, 'PRIMARY_INACTIVE'))).toBe(true);
    });
    it('rejects other 401 codes and wrong status', () => {
      expect(isPrimaryInactiveError(httpError(401, 'DEVICE_AUTH_INVALID'))).toBe(false);
      expect(isPrimaryInactiveError(httpError(403, 'PRIMARY_INACTIVE'))).toBe(false);
      expect(isPrimaryInactiveError(httpError(401, 'BANNED'))).toBe(false);
    });
  });
});
