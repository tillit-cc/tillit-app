import { useCallback, useEffect, useState } from 'react';
import { SignalProtocol } from 'signal-protocol';
import { AppState, AppStateStatus } from 'react-native';

interface BiometricAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  isDeviceSecure: boolean;
  hasStoredIdentity: boolean;
  error: string | null;
}

export function useBiometricAuth() {
  const [state, setState] = useState<BiometricAuthState>({
    isAuthenticated: false,
    isLoading: true,
    isDeviceSecure: true,
    hasStoredIdentity: false,
    error: null,
  });

  // Check initial state
  useEffect(() => {
    checkInitialState();
  }, []);

  // Handle app state changes (lock when backgrounded)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  const checkInitialState = async () => {
    try {
      const [deviceSecure, storedIdentity, authenticated] = await Promise.all([
        SignalProtocol.checkDeviceSecurity(),
        SignalProtocol.hasStoredIdentity(),
        SignalProtocol.isAuthenticated(),
      ]);

      setState({
        isAuthenticated: authenticated.authenticated,
        isLoading: false,
        isDeviceSecure: deviceSecure.isSecure,
        hasStoredIdentity: storedIdentity.hasStoredIdentity,
        error: null,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to check initial state',
      }));
    }
  };

  const handleAppStateChange = async (nextAppState: AppStateStatus) => {
    // Only react to a true backgrounding — iOS fires 'inactive' for transient
    // events (the Face ID / Touch ID prompt itself, control center, incoming
    // calls). Locking on 'inactive' invalidates the LAContext mid-prompt, so
    // the post-auth `loadStoredLocalUser` would either fail or trigger a
    // second biometric prompt.
    if (nextAppState === 'background') {
      await SignalProtocol.lock();
      setState((prev) => ({ ...prev, isAuthenticated: false }));
    }
  };

  const authenticate = useCallback(async (reason?: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const result = await SignalProtocol.authenticate(reason || 'Autenticazione richiesta');

      if (result.success) {
        // Load stored identity after successful authentication
        if (state.hasStoredIdentity) {
          await SignalProtocol.loadStoredLocalUser();
        }

        setState((prev) => ({
          ...prev,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        }));
        return true;
      } else {
        setState((prev) => ({
          ...prev,
          isAuthenticated: false,
          isLoading: false,
          error: result.error || 'Authentication failed',
        }));
        return false;
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isAuthenticated: false,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      }));
      return false;
    }
  }, [state.hasStoredIdentity]);

  const lock = useCallback(async () => {
    await SignalProtocol.lock();
    setState((prev) => ({ ...prev, isAuthenticated: false }));
  }, []);

  const extendSession = useCallback(async () => {
    await SignalProtocol.extendAuthentication();
  }, []);

  return {
    ...state,
    authenticate,
    lock,
    extendSession,
    refreshState: checkInitialState,
  };
}
