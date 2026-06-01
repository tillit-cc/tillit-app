import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import SignalProtocol from 'signal-protocol';
import * as SecureStore from 'expo-secure-store';
import { logger } from '@/utils/logger';
import { useServerStore } from '@/stores/server.store';
import {
  getDefaultApi,
  getDefaultServerToken,
  clearDefaultServerToken,
  getDefaultServerId,
} from '@/services/auth-api-bridge';

// Re-export for consumers that import from auth.store
export { getDefaultApi };

import { buildChallengeMessageBase64 } from '@/utils/challenge';
import { PRIMARY_DEVICE_ID } from '@/config/app.config';
import { isPrimaryRecoveryNotNeededError } from '@/utils/auth-errors';

const USER_ID_KEY = 'signal_user_id';

interface TokenPayload {
  sub: number; // User ID
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  [key: string]: any;
}

export type IdentityState = 'checking' | 'found' | 'not_found' | 'creating';

interface AuthState {
  // State
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  tokenPayload: TokenPayload | null;
  userId: number | null;
  /**
   * This device's libsignal `deviceId`. Cached from
   * `SignalProtocol.getPublicIdentity()` after the local identity unlocks
   * (post biometric authenticate). Stays `null` until then.
   *
   * Used by the multi-device send path to skip self when fanning out
   * (replaces the `=== PRIMARY_DEVICE_ID` heuristic that was correct only
   * for the primary device).
   */
  deviceId: number | null;
  error: string | null;

  // Identity state (for login flow)
  identityState: IdentityState;
  loadingMessage: string;

  // Biometric state
  isBiometricAuthenticated: boolean;
  isDeviceSecure: boolean;
  hasStoredIdentity: boolean;

  // Actions
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setIdentityState: (state: IdentityState) => void;
  setLoadingMessage: (message: string) => void;
  setDeviceId: (deviceId: number | null) => void;

  // Biometric actions
  setBiometricAuthenticated: (authenticated: boolean) => void;
  setDeviceSecure: (secure: boolean) => void;
  setHasStoredIdentity: (hasIdentity: boolean) => void;

  // Auth actions
  authenticateWithBackend: () => Promise<void>;
  /**
   * ADR-0010 primary recovery (OQ-1). Use ONLY on the primary device
   * (`deviceId === 1`) when a normal login was rejected with
   * `DEVICE_AUTH_INVALID` because this device's device-auth key no longer
   * matches the one bound server-side. Runs the 3-step recovery: recovery
   * login (→ recovery-scoped JWT) → re-bind the new device-auth key via
   * `POST /keys` (server WIPES all linked devices) → normal re-login for a
   * regular JWT. DESTRUCTIVE for linked devices — the caller MUST confirm
   * with the user first. See `_shared/api/per-device-server-auth.md`.
   */
  recoverPrimaryAuth: () => Promise<void>;
  logout: () => Promise<void>;
  loadStoredToken: () => Promise<boolean>;
  checkLocalIdentity: () => Promise<boolean>;
  /**
   * Read this device's libsignal deviceId via `getPublicIdentity()` and
   * cache it in the store. Idempotent: callers can invoke it whenever the
   * local identity is unlocked.
   */
  refreshDeviceId: () => Promise<void>;

  // Selectors
  isTokenExpired: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  immer((set, get) => ({
    // Initial state
    isAuthenticated: false,
    isLoading: true,
    token: null,
    tokenPayload: null,
    userId: null,
    deviceId: null,
    error: null,
    identityState: 'checking' as IdentityState,
    loadingMessage: '',
    isBiometricAuthenticated: false,
    isDeviceSecure: true,
    hasStoredIdentity: false,

    // Token actions
    setToken: async (token) => {
      const payload = parseToken(token);
      const api = getDefaultApi();
      await api.setToken(token);

      set((state) => {
        state.token = token;
        state.tokenPayload = payload;
        state.userId = payload?.sub || null;
        state.isAuthenticated = true;
        state.error = null;
      });
    },

    clearToken: async () => {
      await clearDefaultServerToken();

      set((state) => {
        state.token = null;
        state.tokenPayload = null;
        state.userId = null;
        state.deviceId = null;
        state.isAuthenticated = false;
      });
    },

    setLoading: (loading) =>
      set((state) => {
        state.isLoading = loading;
      }),

    setError: (error) =>
      set((state) => {
        state.error = error;
      }),

    setIdentityState: (identityState) =>
      set((state) => {
        state.identityState = identityState;
      }),

    setLoadingMessage: (message) =>
      set((state) => {
        state.loadingMessage = message;
      }),

    // Biometric actions
    setBiometricAuthenticated: (authenticated) =>
      set((state) => {
        state.isBiometricAuthenticated = authenticated;
      }),

    setDeviceSecure: (secure) =>
      set((state) => {
        state.isDeviceSecure = secure;
      }),

    setHasStoredIdentity: (hasIdentity) =>
      set((state) => {
        state.hasStoredIdentity = hasIdentity;
      }),

    setDeviceId: (deviceId) =>
      set((state) => {
        state.deviceId = deviceId;
      }),

    refreshDeviceId: async () => {
      try {
        const pub = await SignalProtocol.getPublicIdentity();
        const id = typeof pub?.deviceId === 'number' ? pub.deviceId : null;
        set((state) => {
          state.deviceId = id;
        });
      } catch (err) {
        logger.warn('[auth.store] refreshDeviceId failed:', err);
      }
    },

    // Check if a local identity exists in the Keychain
    checkLocalIdentity: async () => {
      try {
        const { hasStoredIdentity } = await SignalProtocol.hasStoredIdentity();
        set((state) => {
          state.hasStoredIdentity = hasStoredIdentity;
        });
        return hasStoredIdentity;
      } catch (error) {
        logger.error('[AuthStore] checkLocalIdentity error:', error);
        return false;
      }
    },

    // Challenge-response authentication with backend
    authenticateWithBackend: async () => {
      logger.info('[AuthStore] Authenticating with backend (challenge-response)...');

      const api = getDefaultApi();

      // Get public identity from Signal Protocol plugin
      const publicIdentity = await SignalProtocol.getPublicIdentity();
      const signedPreKeyInfo = await SignalProtocol.getSignedPreKeyInfo();

      // Step 1: Request challenge from backend
      logger.info('[AuthStore] Step 1: Requesting challenge...');
      const challengeResponse = await api.requestChallenge(
        publicIdentity.identityPublicKey
      );

      if (!challengeResponse?.challengeId || !challengeResponse?.nonce) {
        throw new Error('Invalid challenge response from backend');
      }

      // Step 2: Sign the nonce with identity private key (stays in native code).
      // Domain-separated to prevent signature confusion with SignedPreKey / KyberPreKey
      // signatures, which are produced with the same identity key.
      logger.info('[AuthStore] Step 2: Signing challenge...');
      const challengeMessage = buildChallengeMessageBase64(
        challengeResponse.nonce,
        api.baseUrl
      );
      const { signature: challengeSignature } = await SignalProtocol.signWithIdentityKey(
        challengeMessage
      );

      // ADR-0010: also sign the SAME challenge message with the per-device
      // server-auth key. The server requires this once the device has a
      // registered device-auth key (bound on the first POST /keys), binding
      // `deviceId` to a key only this device holds — a linked device can no
      // longer claim `deviceId: 1`. During transition mode the server ignores
      // it, so sending it unconditionally is safe.
      const { signature: deviceAuthSignature } = await SignalProtocol.signWithDeviceAuth(
        challengeMessage
      );

      // Step 3: Submit signed challenge to authenticate
      logger.info('[AuthStore] Step 3: Authenticating with signed challenge...');
      const response = await api.authenticateWithIdentity({
        identityPublicKey: publicIdentity.identityPublicKey,
        registrationId: publicIdentity.registrationId,
        deviceId: publicIdentity.deviceId,
        signedPreKeyPublicKey: signedPreKeyInfo.publicKey,
        signedPreKeyId: signedPreKeyInfo.id,
        signedPreKeySignature: signedPreKeyInfo.signature,
        challengeId: challengeResponse.challengeId,
        challengeSignature,
        deviceAuthSignature,
      });

      if (!response?.accessToken) {
        throw new Error('No access token received from backend');
      }

      // Save token
      const payload = parseToken(response.accessToken);
      await api.setToken(response.accessToken);

      // Save userId for future app restarts
      await SecureStore.setItemAsync(USER_ID_KEY, String(response.userId));

      // Update LocalUser name to match userId for ProtocolAddress consistency
      logger.info('[AuthStore] Setting local user ID');
      await SignalProtocol.setLocalUserId(String(response.userId));

      set((state) => {
        state.token = response.accessToken;
        state.tokenPayload = payload;
        state.userId = response.userId;
        state.isAuthenticated = true;
        state.isBiometricAuthenticated = true;
        state.error = null;
      });

      // Mark default server as banned if flagged in auth response
      if (response.banned) {
        logger.warn('[AuthStore] Default server flagged user as banned');
        const defServerId = getDefaultServerId();
        if (defServerId !== null) {
          useServerStore.getState().setBanned(defServerId, true);
        }
      }

      logger.info('[AuthStore] Authenticated successfully');
    },

    // ADR-0010 primary recovery (OQ-1) — see the type declaration for the
    // contract. The new device-auth key was already lazily (re)generated by
    // the failed normal login's `signWithDeviceAuth`, so by here the device
    // already holds the key whose public half we re-bind below.
    recoverPrimaryAuth: async () => {
      logger.info('[AuthStore] Primary recovery: starting...');
      const api = getDefaultApi();

      const publicIdentity = await SignalProtocol.getPublicIdentity();
      if (publicIdentity.deviceId !== PRIMARY_DEVICE_ID) {
        throw new Error('Primary recovery is only valid on the primary device');
      }
      const signedPreKeyInfo = await SignalProtocol.getSignedPreKeyInfo();

      // Step 1: recovery login. Identity signature only — `deviceAuthSignature`
      // is intentionally OMITTED — with `recoverPrimary: true`. Yields a
      // recovery-scoped JWT usable only for the re-bind in step 2.
      logger.info('[AuthStore] Recovery step 1: recovery login...');
      const challengeResponse = await api.requestChallenge(publicIdentity.identityPublicKey);
      if (!challengeResponse?.challengeId || !challengeResponse?.nonce) {
        throw new Error('Invalid challenge response from backend');
      }
      const challengeMessage = buildChallengeMessageBase64(
        challengeResponse.nonce,
        api.baseUrl,
      );
      const { signature: challengeSignature } = await SignalProtocol.signWithIdentityKey(
        challengeMessage,
      );

      try {
        const recoveryResponse = await api.authenticateWithIdentity({
          identityPublicKey: publicIdentity.identityPublicKey,
          registrationId: publicIdentity.registrationId,
          deviceId: publicIdentity.deviceId,
          signedPreKeyPublicKey: signedPreKeyInfo.publicKey,
          signedPreKeyId: signedPreKeyInfo.id,
          signedPreKeySignature: signedPreKeyInfo.signature,
          challengeId: challengeResponse.challengeId,
          challengeSignature,
          recoverPrimary: true,
        });
        if (!recoveryResponse?.accessToken) {
          throw new Error('No recovery token received from backend');
        }
        // The recovery-scoped JWT authorizes ONLY the re-bind below.
        await api.setToken(recoveryResponse.accessToken);
      } catch (error: any) {
        // The device has no auth key bound server-side → no deadlock, plain
        // transition-mode login already works. Fall back to a normal login.
        if (isPrimaryRecoveryNotNeededError(error)) {
          logger.warn('[AuthStore] Recovery not needed — falling back to normal login');
          await get().authenticateWithBackend();
          return;
        }
        throw error;
      }

      // Step 2: re-bind the new device-auth key. The server revokes ALL linked
      // devices (clean slate). Uses the recovery-scoped JWT set above.
      logger.info('[AuthStore] Recovery step 2: re-binding device-auth key (wipes linked)...');
      const { publicKey: deviceAuthPublicKey } = await SignalProtocol.getDeviceAuthPublicKey();
      await api.recoverPrimaryAuthKey(deviceAuthPublicKey);

      // Step 3: normal re-login for a regular JWT (signs with the new
      // device-auth key, now bound). Replaces the recovery-scoped token.
      logger.info('[AuthStore] Recovery step 3: normal re-login...');
      await get().authenticateWithBackend();
      logger.info('[AuthStore] Primary recovery complete');
    },

    logout: async () => {
      // Clear stored user ID
      await SecureStore.deleteItemAsync(USER_ID_KEY);

      // Reset store state (Signal Protocol/token cleanup is handled by appInitService.logout())
      set((state) => {
        state.token = null;
        state.tokenPayload = null;
        state.userId = null;
        state.isAuthenticated = false;
        state.isBiometricAuthenticated = false;
        state.hasStoredIdentity = false;
        state.identityState = 'not_found';
        state.error = null;
      });
    },

    loadStoredToken: async () => {
      set((state) => {
        state.isLoading = true;
      });

      try {
        // Check device security first
        const { isSecure } = await SignalProtocol.checkDeviceSecurity();
        set((state) => {
          state.isDeviceSecure = isSecure;
        });

        if (!isSecure) {
          set((state) => {
            state.isLoading = false;
          });
          return false;
        }

        // Load stored token from SecureStore (default server)
        const token = await getDefaultServerToken();

        if (token) {
          const payload = parseToken(token);

          // Check if token is valid and not expired
          if (payload && payload.exp && payload.exp * 1000 > Date.now()) {
            // Load stored userId
            const storedUserId = await SecureStore.getItemAsync(USER_ID_KEY);

            logger.info('[AuthStore] Restored session for user');

            set((state) => {
              state.token = token;
              state.tokenPayload = payload;
              state.userId = storedUserId ? parseInt(storedUserId, 10) : payload.sub;
              state.isAuthenticated = true;
              state.isBiometricAuthenticated = false; // Require biometric unlock
              state.isLoading = false;
            });

            return true;
          } else {
            logger.info('[AuthStore] Stored token is expired, clearing');
            await clearDefaultServerToken();
          }
        }

        // No valid default token — check if user has logged in before
        const storedUserId = await SecureStore.getItemAsync(USER_ID_KEY);
        if (storedUserId) {
          logger.info('[AuthStore] No valid token but identity exists — restoring session');
          set((state) => {
            state.token = null;
            state.tokenPayload = null;
            state.userId = parseInt(storedUserId, 10);
            state.isAuthenticated = true;
            state.isBiometricAuthenticated = false;
            state.isLoading = false;
          });
          return true;
        }

        // No identity — need to authenticate via login
        set((state) => {
          state.isLoading = false;
          state.isAuthenticated = false;
          state.isBiometricAuthenticated = false;
        });

        return false;
      } catch (error) {
        logger.error('[AuthStore] loadStoredToken error:', error);
        set((state) => {
          state.isLoading = false;
          state.isAuthenticated = false;
        });
        return false;
      }
    },

    // Selectors
    isTokenExpired: () => {
      const { tokenPayload } = get();
      if (!tokenPayload || !tokenPayload.exp) return true;
      return tokenPayload.exp * 1000 < Date.now();
    },
  }))
);

// Helper function to parse JWT token
function parseToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode base64url to base64
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const paddedBase64 = base64 + padding;

    // Decode and parse
    return JSON.parse(atob(paddedBase64));
  } catch {
    return null;
  }
}
