import { useEffect, useCallback } from 'react';
import { View, Text, ActivityIndicator, Alert, Image, Linking, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import { Button } from '@/components/ui/Button';
import { useAuthStore, getDefaultApi } from '@/stores/auth.store';
import { useDeviceStore } from '@/stores/device.store';
import { appInitService } from '@/services/app-init.service';
import { initDatabase } from '@/db/client';
import SignalProtocol from 'signal-protocol';
import { PRIMARY_DEVICE_ID } from '@/config/app.config';
import { logger } from '@/utils/logger';
import {
  isDeviceAuthError,
  isDeviceAuthRequiredError,
  isDeviceAuthMismatchError,
  isPrimaryInactiveError,
} from '@/utils/auth-errors';

const PRIVACY_POLICY_URL = 'https://tillit.cc/privacy-policy.html';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Check if the error is a ban response (401 with error: 'BANNED'). */
function isBannedError(error: any): boolean {
  return error?.response?.status === 401 && error.response.data?.error === 'BANNED';
}

/**
 * Build a verbose diagnostic string from any error (Axios or generic) for the
 * `logger` sink only. URLs, HTTP status codes and response bodies are useful
 * for debugging but must never end up in an Alert dialog visible to the user
 * — they can be photographed and leak server-side internals.
 */
function describeErrorForLog(error: any): string {
  if (error?.response) {
    const { status, data, config } = error.response;
    const url = config?.url ?? '?';
    const method = (config?.method ?? '?').toUpperCase();
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return `${method} ${url}\nHTTP ${status}\n${body}`;
  }
  if (error?.request) {
    const url = error.config?.url ?? '?';
    const method = (error.config?.method ?? '?').toUpperCase();
    const base = error.config?.baseURL ?? '';
    return `${method} ${base}${url}\n${error.message ?? 'Network Error'}`;
  }
  return error?.message ?? String(error);
}

/**
 * L4: Returns true if the device-pairing store is in a non-terminal phase
 * on either side (primary scanner OR new device). Used by the wipe paths
 * to refuse to throw away the identity while a linked device is mid-flight
 * — see the comments in `wipeAndCreate` / `deleteLocalIdentity` for the
 * concrete failure mode this guards against.
 */
function isPairingInProgress(): boolean {
  const { pairingPrimary, pairingNewDevice } = useDeviceStore.getState();
  const inFlight = (phase: string | undefined) =>
    phase !== undefined && phase !== 'idle' && phase !== 'done' && phase !== 'error';
  return inFlight(pairingPrimary?.phase) || inFlight(pairingNewDevice?.phase);
}

/**
 * User-facing error summary. Keeps the dialog informative (was it a network
 * issue, an HTTP error, or a generic JS error?) without leaking the host,
 * path or response payload.
 */
function describeErrorForUser(error: any): string {
  if (error?.response) {
    const status = error.response.status;
    return `HTTP ${status}`;
  }
  if (error?.request) {
    return i18next.t('auth.noServerResponse');
  }
  return error?.message ?? i18next.t('auth.connectionFailed');
}

export default function LoginScreen() {
  const {
    identityState,
    loadingMessage,
    setIdentityState,
    setLoadingMessage,
    authenticateWithBackend,
  } = useAuthStore();

  const { t } = useTranslation();
  const router = useRouter();

  // ADR-0011: surface a device-auth login rejection. There is NO recovery —
  // losing the device-auth key is unrecoverable server-side. On the primary
  // device the only path is to recreate the account (the "Create new
  // identity" action wipes + re-registers). On a linked device the only cure
  // is re-pairing. Either way we just explain.
  const presentDeviceAuthError = useCallback(
    async (error: any) => {
      logger.warn('[Login] Device-auth rejected:', describeErrorForLog(error));
      if (isDeviceAuthRequiredError(error)) {
        Alert.alert(t('auth.deviceAuthInvalidTitle'), t('auth.deviceAuthRequiredMsg'));
        return;
      }
      // INVALID or MISMATCH. Tailor the copy to primary vs linked: the primary
      // must recreate the account, a linked device re-pairs.
      let isPrimary = false;
      try {
        const pub = await SignalProtocol.getPublicIdentity();
        isPrimary = pub?.deviceId === PRIMARY_DEVICE_ID;
      } catch {
        // If we can't read the identity, fall back to the linked-device copy.
      }
      Alert.alert(
        t('auth.deviceAuthInvalidTitle'),
        isPrimary ? t('auth.primaryUnrecoverableMsg') : t('auth.deviceAuthInvalidMsg'),
      );
    },
    [t],
  );

  // ADR-0011 liveness lock: a linked device tried to sign in while the primary
  // has been idle past the server threshold. TEMPORARY and REVERSIBLE — not a
  // logout/revoke. Tell the user to bring the primary back online and retry.
  const presentPrimaryInactiveError = useCallback(
    (error: any) => {
      logger.warn('[Login] Primary inactive (liveness lock):', describeErrorForLog(error));
      Alert.alert(t('auth.primaryInactiveTitle'), t('auth.primaryInactiveMsg'));
    },
    [t],
  );

  // Check local identity on mount
  useEffect(() => {
    async function checkIdentity() {
      setIdentityState('checking');
      setLoadingMessage(t('auth.searchingIdentity'));

      await delay(800);

      try {
        const { hasStoredIdentity } = await SignalProtocol.hasStoredIdentity();
        if (hasStoredIdentity) {
          logger.info('[Login] Identity found - user needs to auth with backend');
          setIdentityState('found');
        } else {
          logger.info('[Login] No identity found - first time user');
          setIdentityState('not_found');
        }
      } catch (error) {
        logger.error('[Login] Error checking identity:', error);
        setIdentityState('not_found');
      }
    }

    checkIdentity();
  }, [setIdentityState, setLoadingMessage]);

  // Read all protected-storage key material (the public bundle + the
  // ADR-0010 device-auth public key). MUST be called while the biometric
  // unlock window is open and BEFORE `authenticateWithBackend` flips
  // `isAuthenticated`: that flip triggers navigation to /(tabs) →
  // appInitService.initialize(), whose `registerPush` step pops the Android 13+
  // notification-permission dialog, backgrounding the app and locking the
  // keystore (app-init.service.ts handleAppStateChange → SignalProtocol.lock()).
  // If the read happened after the flip it raced that lock and threw
  // "Must call authenticate() first" on getDeviceAuthPublicKey.
  const readKeyMaterial = useCallback(async () => {
    const bundle = await SignalProtocol.getFullPublicBundle();
    // ADR-0010: register this device's server-auth public key alongside the
    // bundle (TOFU-bound server-side on first upload, idempotent after).
    const { publicKey: deviceAuthPublicKey } = await SignalProtocol.getDeviceAuthPublicKey();
    return { bundle, deviceAuthPublicKey };
  }, []);

  // Sync public keys to server. Takes pre-read key material so no protected
  // storage is touched here — see `readKeyMaterial` for why that matters.
  const syncPublicKeys = useCallback(async (
    { bundle, deviceAuthPublicKey }: Awaited<ReturnType<typeof readKeyMaterial>>,
  ) => {
    const payload = {
      deviceId: bundle.deviceId,
      registrationId: bundle.registrationId,
      identityPublicKey: bundle.identityPublicKey,
      deviceAuthPublicKey,
      signedPreKey: {
        keyId: bundle.signedPreKey.id,
        keyData: bundle.signedPreKey.publicKey,
        signature: bundle.signedPreKey.signature,
      },
      preKeys: bundle.preKeys.slice(0, 100).map((pk) => ({
        keyId: pk.id,
        keyData: pk.publicKey,
      })),
      kyberPreKeys: bundle.kyberPreKeys.slice(0, 100).map((kpk) => ({
        keyId: kpk.id,
        keyData: kpk.publicKey,
        signature: kpk.signature,
      })),
    };
    const api = getDefaultApi();
    await api.syncPublicKeys(payload);
    logger.info('[Login] Public keys synced');
  }, []);

  // Continue with existing identity
  const continueWithExisting = useCallback(async () => {
    logger.info('[Login] Continuing with existing identity');
    setIdentityState('creating');
    setLoadingMessage(t('auth.authenticating'));

    try {
      // Biometric authentication
      const authResult = await SignalProtocol.authenticate(
        t('auth.unlockPrompt'),
      );
      if (!authResult.success) {
        logger.warn('[Login] Biometric authentication failed:', authResult.error);
        Alert.alert(t('common.error'), t('auth.authFailed'));
        setIdentityState('found');
        return;
      }

      // Load keys from Keychain
      setLoadingMessage(t('auth.loadingKeys'));
      const loadResult = await SignalProtocol.loadStoredLocalUser();
      if (!loadResult.success) {
        logger.error('[Login] Failed to load stored local user');
        Alert.alert(t('common.error'), t('auth.identityLoadError'));
        setIdentityState('found');
        return;
      }
      await delay(300);

      // Read key material while the unlock window is still open, before the
      // authenticateWithBackend flip kicks off appInit (see readKeyMaterial).
      const keyMaterial = await readKeyMaterial();

      // Authenticate with backend (challenge-response)
      // If default server is banned but returns userId, authenticateWithBackend
      // handles it internally (sets isAuthenticated=true, marks server banned).
      setLoadingMessage(t('auth.connectingServer'));
      await authenticateWithBackend();
      await delay(300);

      // Sync public keys
      setLoadingMessage(t('auth.syncingKeys'));
      await syncPublicKeys(keyMaterial);
      await delay(300);

      logger.info('[Login] Login complete - navigating to tabs');
      // Fallback navigation: _layout.tsx redirect should have navigated already
      // when authenticateWithBackend set isAuthenticated=true, but during dev
      // reloads the redirect can silently fail due to stale navigation state.
      router.replace('/(tabs)');
    } catch (error: any) {
      if (isBannedError(error)) {
        logger.warn('[Login] User is banned');
        Alert.alert(t('report.serverBanned'), t('auth.accountBanned'));
      } else if (isPrimaryInactiveError(error)) {
        // ADR-0011 liveness lock: reversible, not a logout. Identity stays
        // intact — user retries once the primary is back online.
        presentPrimaryInactiveError(error);
      } else if (isDeviceAuthError(error) || isDeviceAuthMismatchError(error)) {
        // ADR-0010/0011: this device's server-auth credential is missing/stale
        // — 401 at login (INVALID/REQUIRED) or 409 at /keys (MISMATCH: the
        // server has a different device-auth key bound). No recovery: on the
        // primary the cure is recreating the account, on a linked device it is
        // re-pairing. `presentDeviceAuthError` explains the right path.
        await presentDeviceAuthError(error);
      } else {
        logger.error('[Login] continueWithExisting error:', describeErrorForLog(error));
        Alert.alert(
          t('auth.connectionError'),
          `${t('auth.connectionFailed')}\n\n${describeErrorForUser(error)}`,
        );
      }
      setIdentityState('found');
    }
  }, [authenticateWithBackend, readKeyMaterial, syncPublicKeys, setIdentityState, setLoadingMessage, router, presentDeviceAuthError, presentPrimaryInactiveError, t]);

  // Wipe all data and create new identity
  const wipeAndCreate = useCallback(async () => {
    // L4: don't wipe the identity while a pairing flow is in progress.
    // If a new device is mid-pairing and we wipe here, the new device
    // will install a copy of an identity that this device is about to
    // throw away — leaving the linked device orphaned with an obsolete
    // keypair. Same problem on the new-device side: a wipe here means
    // the linked device that just installed our identity will diverge
    // from the freshly-created one.
    if (isPairingInProgress()) {
      Alert.alert(t('auth.pairingActiveTitle'), t('auth.pairingActiveMsg'));
      return;
    }

    setIdentityState('creating');

    try {
      // Phase 1: Teardown + wipe filesystem artifacts.
      // We cannot open the DB here because its encryption key lives in
      // hardware-protected storage that requires biometric auth (not yet
      // performed). Deleting the file on disk achieves the same outcome.
      setLoadingMessage(t('auth.cleaningData'));
      logger.info('[Login] Wiping all data...');
      appInitService.destroy();
      try {
        await SignalProtocol.clearIdentity();
      } catch (e) {
        // Ignore if no identity to clear
      }
      await getDefaultApi().clearToken();
      const { wipeDatabaseFiles } = require('@/db/client');
      wipeDatabaseFiles();
      const { deleteAllImages } = require('@/utils/image');
      try { deleteAllImages(); } catch {}
      await delay(500);

      // Phase 2: Authenticate with biometrics before key generation
      setLoadingMessage(t('auth.authRequired'));
      const authResult = await SignalProtocol.authenticate(
        t('auth.createIdentityPrompt'),
      );
      if (!authResult.success) {
        throw new Error('Biometric authentication required to create identity');
      }

      // Phase 2b: Initialize a fresh encrypted DB (the encryption key is now
      // created in hardware-protected storage because auth is active).
      await initDatabase();

      // Phase 3: Generate keys (private keys stay in native code).
      // Every fresh install registers as the primary device (PRIMARY_DEVICE_ID = 1
      // by convention with Signal / WhatsApp / libsignal). Linked devices, once
      // multi-device pairing is implemented, will receive their own deviceId
      // from the backend at pairing time and use that value here instead.
      setLoadingMessage(t('auth.generatingKeys'));
      logger.info('[Login] Generating keys via initializeIdentity...');
      await SignalProtocol.initializeIdentity(PRIMARY_DEVICE_ID, 'TilliT User');
      logger.info('[Login] Identity initialized');
      await delay(300);

      // Phase 3b: Read key material now — the unlock window is open and no
      // navigation/appInit has been triggered yet. Doing this before Phase 4
      // avoids the lock race that broke getDeviceAuthPublicKey (see
      // readKeyMaterial). This also lazily generates the device-auth keypair,
      // which authenticateWithBackend's signWithDeviceAuth then reuses.
      const keyMaterial = await readKeyMaterial();

      // Phase 4: Authenticate with backend
      setLoadingMessage(t('auth.registeringIdentity'));
      await authenticateWithBackend();
      await delay(300);

      // Phase 5: Sync public keys
      setLoadingMessage(t('auth.syncingKeys'));
      await syncPublicKeys(keyMaterial);
      await delay(300);

      logger.info('[Login] Identity created successfully - navigating to tabs');
      router.replace('/(tabs)');
    } catch (error: any) {
      if (isBannedError(error)) {
        logger.warn('[Login] User is banned');
        Alert.alert(t('report.serverBanned'), t('auth.accountBanned'));
        setIdentityState('not_found');
      } else {
        logger.error('[Login] wipeAndCreate error:', describeErrorForLog(error));
        Alert.alert(
          t('common.error'),
          `${t('auth.identityCreateError')}\n\n${describeErrorForUser(error)}`,
        );
        setIdentityState('not_found');
      }
    }
  }, [authenticateWithBackend, readKeyMaterial, syncPublicKeys, setIdentityState, setLoadingMessage, router]);

  // Create new identity with confirmation (when existing identity found)
  const createNewIdentity = useCallback(async () => {
    Alert.alert(
      t('auth.newIdentityTitle'),
      t('auth.newIdentityMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.confirm'), style: 'destructive', onPress: wipeAndCreate },
      ]
    );
  }, [wipeAndCreate]);

  // Delete local identity (keys from Keychain only)
  const deleteLocalIdentity = useCallback(async () => {
    // L4: see the symmetric guard in `wipeAndCreate` — both wipe paths
    // need to refuse while a pairing is active.
    if (isPairingInProgress()) {
      Alert.alert(t('auth.pairingActiveTitle'), t('auth.pairingActiveMsg'));
      return;
    }
    Alert.alert(
      t('auth.deleteIdentityTitle'),
      t('auth.deleteIdentityMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            setIdentityState('creating');
            setLoadingMessage(t('auth.deletingIdentity'));
            try {
              await SignalProtocol.clearIdentity();
              await getDefaultApi().clearToken();
              // Wipe DB by deleting the file on disk — we don't reopen it
              // (no auth here, and the next time the app authenticates a
              // fresh DB will be created on demand).
              const { wipeDatabaseFiles } = require('@/db/client');
              wipeDatabaseFiles();
              try {
                const { deleteAllImages } = require('@/utils/image');
                deleteAllImages();
              } catch {}
              setIdentityState('not_found');
            } catch (error) {
              logger.error('[Login] deleteLocalIdentity error:', error);
              Alert.alert(t('common.error'), t('auth.deleteError'));
              setIdentityState('found');
            }
          },
        },
      ]
    );
  }, [setIdentityState, setLoadingMessage]);

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900">
      <View className="flex-1 px-6">
        {/* Logo pinned at top (absolute so it doesn't affect centering) */}
        <View className="absolute top-12 left-0 right-0 items-center z-10">
          <Image
            source={require('@/assets/images/tillit.png')}
            className="w-20 h-20"
            resizeMode="contain"
          />
        </View>

        {/* Center content (centered relative to full page) */}
        <View className="flex-1 items-center justify-center">
          {/* CHECKING STATE */}
          {identityState === 'checking' && (
            <View className="items-center">
              <ActivityIndicator size="large" color="#2ad1af" />
              <Text className="mt-4 text-base text-gray-500 dark:text-gray-400">
                {loadingMessage}
              </Text>
            </View>
          )}

          {/* FOUND STATE - Welcome back */}
          {identityState === 'found' && (
            <View className="items-center w-full">
              <Text className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
                {t('auth.welcomeBack')}
              </Text>
              <Text className="text-base text-gray-500 dark:text-gray-400 mb-8">
                {t('auth.foundIdentity')}
              </Text>

              <View className="w-full gap-3">
                <Button onPress={continueWithExisting} size="lg">
                  {t('auth.continueBtn')}
                </Button>
                <Button onPress={createNewIdentity} variant="outline" size="lg">
                  {t('auth.createNewIdentity')}
                </Button>
              </View>

              <View className="mt-6">
                <Button
                  onPress={deleteLocalIdentity}
                  variant="ghost"
                  size="sm"
                >
                  <Text className="text-red-500 text-sm">
                    {t('auth.deleteLocalIdentity')}
                  </Text>
                </Button>
              </View>
            </View>
          )}

          {/* NOT FOUND STATE - Welcome */}
          {identityState === 'not_found' && (
            <View className="items-center w-full">
              <Text className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
                {t('auth.welcome')}
              </Text>
              <Text className="text-base text-gray-500 dark:text-gray-400 mb-8">
                {t('auth.secureMessages')}
              </Text>

              <View className="w-full gap-3">
                <Button onPress={wipeAndCreate} size="lg">
                  {t('auth.createIdentity')}
                </Button>
                <Button
                  onPress={() => router.push('/claim-device')}
                  variant="outline"
                  size="lg"
                >
                  {t('linkedDevices.claimTitle')}
                </Button>
              </View>
            </View>
          )}

          {/* CREATING STATE - Loading with phases */}
          {identityState === 'creating' && (
            <View className="items-center">
              <ActivityIndicator size="large" color="#2ad1af" />
              <Text className="mt-4 text-base text-gray-500 dark:text-gray-400">
                {loadingMessage}
              </Text>
            </View>
          )}
        </View>

        {/* Footer - outside flex-1 center, stays at bottom */}
        <View className="pb-4">
          <Text className="text-xs text-gray-400 dark:text-gray-500 text-center">
            {t('auth.e2eFooter')}
          </Text>
          <Pressable
            onPress={() => {
              Linking.openURL(PRIVACY_POLICY_URL).catch((err) =>
                logger.warn('[Login] Failed to open privacy policy:', err),
              );
            }}
            accessibilityRole="link"
            className="mt-2 self-center px-3 py-1"
          >
            <Text className="text-xs text-gray-500 dark:text-gray-400 underline">
              {t('profile.privacyPolicy')}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
