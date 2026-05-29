import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  Alert,
  ScrollView,
  Pressable,
  Platform,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import QRCode from 'react-native-qrcode-svg';
import * as Device from 'expo-device';
import SignalProtocol from 'signal-protocol';
import { Button } from '@/components/ui/Button';
import { useDeviceStore } from '@/stores/device.store';
import { deviceService } from '@/services/device.service';
import { serverRegistry } from '@/services/server-registry';
import { logger } from '@/utils/logger';

/**
 * New-device side (wire v2.1): show a QR for the primary to scan, wait
 * for the primary to deposit P_pub via /share-pubkey (intermediate
 * `pubkey-shared` status on /result polling), confirm the safety number
 * out-of-band, then — once /complete fires — install the imported
 * identity into the Keychain.
 *
 * Phase machine (mirrors `pairingNewDevice` in device.store):
 *   - init        → spinner ("Preparing pairing…")
 *   - waiting     → QR shown + countdown to expiry
 *   - polling     → QR remains visible, polling in background
 *   - safetyCheck → SN + Match / Don't match (wire v2.1: entered at
 *                   `pubkey-shared`, before /complete). If the user
 *                   taps Match before /complete arrives, the buttons
 *                   are hidden and a spinner ("waiting for primary…")
 *                   is shown until install can proceed.
 *   - installing  → spinner ("Installing identity…")
 *   - done        → success → redirect to /(auth)/login
 *   - error       → message + Retry
 */
export default function ClaimDeviceScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const pairing = useDeviceStore((s) => s.pairingNewDevice);
  const startedRef = useRef(false);
  const [deviceName, setDeviceName] = useState<string>(
    Device.modelName ?? Device.deviceName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android'),
  );

  // Server origin display (read-only here, can be changed via the
  // ServerStatusModal entry in profile / login). Default origin comes
  // from the registry — coherent with multi-server policy.
  const serverOrigin = useMemo(() => {
    return serverRegistry.getDefaultServer()?.apiUrl ?? '';
  }, []);

  // Auto-start the pairing flow once we have a device name. We wait for
  // mount (one render) so the user briefly sees the form before the QR
  // is generated, allowing rename.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        await deviceService.startNewDeviceLink(deviceName);
        if (cancelled) return;
        deviceService.pollNewDeviceSessionResult().catch((err) => {
          logger.warn('[ClaimDevice] pollNewDeviceSessionResult error:', err?.message ?? err);
        });
      } catch (err) {
        logger.warn('[ClaimDevice] startNewDeviceLink error:', err);
      }
    })();

    return () => {
      cancelled = true;
      const currentPhase = useDeviceStore.getState().pairingNewDevice?.phase;
      if (currentPhase && currentPhase !== 'done') {
        deviceService.cancelNewDeviceLink().catch(() => undefined);
      } else {
        useDeviceStore.getState().clearNewDevicePairing();
      }
    };
    // We intentionally start once on mount with the initial device name.
    // Subsequent edits to the input field are tolerated — the rename can
    // be applied after install via /(auth)/login if needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Countdown to session expiry ----------
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    const expiresAt = pairing?.expiresAt;
    if (!expiresAt || (pairing?.phase !== 'waiting' && pairing?.phase !== 'polling')) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [pairing?.phase, pairing?.expiresAt]);

  // ---------- Handlers ----------
  const handleSafetyMatch = useCallback(async () => {
    try {
      // Biometric/passcode gate before persisting the imported identity.
      // On a fresh install the Keychain ACL needs an unlock before any
      // protected write can succeed.
      const auth = await SignalProtocol.authenticate(t('auth.createIdentityPrompt'));
      if (!auth.success) {
        Alert.alert(t('common.error'), t('auth.authFailed'));
        return;
      }
      await deviceService.confirmNewDeviceSafetyAndInstall(deviceName);
      useDeviceStore.getState().setNewDevicePhase('done');
    } catch (err) {
      logger.warn('[ClaimDevice] install failed:', err);
    }
  }, [deviceName, t]);

  const handleSafetyMismatch = useCallback(() => {
    Alert.alert(
      t('linkedDevices.safetyNumberMismatchConfirmTitle'),
      t('linkedDevices.safetyNumberMismatchConfirmMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('linkedDevices.safetyNumberMismatchConfirmAction'),
          style: 'destructive',
          onPress: async () => {
            await deviceService.cancelNewDeviceLink();
            router.back();
          },
        },
      ],
    );
  }, [t, router]);

  const handleCancel = useCallback(async () => {
    await deviceService.cancelNewDeviceLink();
    router.back();
  }, [router]);

  const handleDone = useCallback(() => {
    useDeviceStore.getState().clearNewDevicePairing();
    router.replace('/(auth)/login');
  }, [router]);

  const handleRetry = useCallback(async () => {
    useDeviceStore.getState().clearNewDevicePairing();
    try {
      await deviceService.startNewDeviceLink(deviceName);
      deviceService.pollNewDeviceSessionResult().catch(() => undefined);
    } catch (err) {
      logger.warn('[ClaimDevice] retry failed:', err);
    }
  }, [deviceName]);

  // ---------- Error message mapping ----------
  const errorText = useMemo(() => {
    if (!pairing?.errorMessage) return null;
    switch (pairing.errorMessage) {
      case 'NO_SERVER':
        return t('linkedDevices.errorNoServer');
      case 'INVALID_EPHEMERAL_KEY':
        return t('linkedDevices.errorGeneric');
      case 'TOO_MANY_LINKS':
        return t('linkedDevices.errorTooManyLinks');
      case 'SESSION_EXPIRED':
      case 'POLL_TIMEOUT':
        return t('linkedDevices.errorTokenExpired');
      case 'SESSION_ALREADY_CONSUMED':
        return t('linkedDevices.errorAlreadyConsumed');
      case 'SESSION_NOT_FOUND':
        return t('linkedDevices.errorTokenNotFound');
      case 'IDENTITY_KEY_TAMPERED':
        return t('linkedDevices.errorIdentityTampered');
      case 'PUBKEY_SHARED_MISSING':
        return t('linkedDevices.errorPubkeySharedMissing');
      case 'ASSIGNED_DEVICE_ID_MISMATCH':
        return t('linkedDevices.errorAssignedDeviceIdMismatch');
      default:
        return t('linkedDevices.errorGeneric');
    }
  }, [pairing?.errorMessage, t]);

  const phase = pairing?.phase ?? 'init';

  // ---------- Header ----------
  const header = (
    <View className="flex-row items-center justify-between px-4 py-3 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
      <Text className="text-lg font-semibold text-gray-900 dark:text-white">
        {t('linkedDevices.claimTitle')}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        onPress={handleCancel}
        hitSlop={8}
      >
        <Ionicons name="close" size={24} color="#6b7280" />
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-gray-950" edges={['top', 'bottom']}>
      {header}

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {phase === 'init' && (
          <View className="items-center py-12">
            <ActivityIndicator size="large" />
            <Text className="mt-4 text-base text-gray-700 dark:text-gray-300">
              {t('linkedDevices.claimInitMsg')}
            </Text>
          </View>
        )}

        {(phase === 'waiting' || phase === 'polling') && pairing?.provisioningUrl && (
          <View className="items-center">
            <Text className="text-base font-semibold text-gray-900 dark:text-white text-center">
              {t('linkedDevices.claimWaitingTitle')}
            </Text>
            <Text className="text-sm text-gray-600 dark:text-gray-400 text-center mt-2 mb-2">
              {t('linkedDevices.claimWaitingDescription')}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 text-center mb-4">
              {t('linkedDevices.claimServerOrigin', { origin: serverOrigin })}
            </Text>

            <View className="bg-white p-4 rounded-2xl">
              <QRCode
                value={pairing.provisioningUrl}
                size={240}
                backgroundColor="#ffffff"
                color="#000000"
              />
            </View>

            <View className="mt-4 flex-row items-center gap-2">
              <Ionicons name="time-outline" size={16} color="#6b7280" />
              <Text className="text-sm text-gray-500 dark:text-gray-400">
                {secondsLeft != null
                  ? t('linkedDevices.primaryTokenExpires', { seconds: secondsLeft })
                  : ''}
              </Text>
            </View>

            <View className="mt-4 w-full">
              <TextInput
                value={deviceName}
                onChangeText={setDeviceName}
                placeholder={t('linkedDevices.claimEnterDeviceName')}
                placeholderTextColor="#9ca3af"
                className="text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 rounded-lg px-4 py-3"
              />
              <Text className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                {t('linkedDevices.claimDeviceNameHint')}
              </Text>
            </View>

            <View className="mt-6 w-full">
              <Button onPress={handleCancel} variant="ghost" size="md">
                <Text className="text-gray-500">{t('common.cancel')}</Text>
              </Button>
            </View>
          </View>
        )}

        {phase === 'safetyCheck' && pairing?.safetyNumber && (
          <View>
            <Text className="text-base font-semibold text-gray-900 dark:text-white text-center mt-4">
              {t('linkedDevices.claimSafetyTitle')}
            </Text>
            <Text className="text-sm text-gray-600 dark:text-gray-400 text-center mt-2 mb-6">
              {t('linkedDevices.claimSafetyDescription')}
            </Text>
            <View className="bg-white dark:bg-gray-900 rounded-2xl p-5 mb-6">
              <Text className="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 mb-3">
                {t('linkedDevices.safetyNumberTitle')}
              </Text>
              <Text
                className="text-lg font-mono text-gray-900 dark:text-white tracking-widest leading-7"
                accessibilityLabel="safety-number"
              >
                {pairing.safetyNumber}
              </Text>
            </View>
            {pairing.safetyConfirmed ? (
              // Wire v2.1: user tapped Match before /complete arrived.
              // The service is awaiting the encrypted payload — show
              // progress instead of the buttons so the user doesn't try
              // to tap again.
              <View className="items-center py-4">
                <ActivityIndicator size="small" />
                <Text className="mt-3 text-sm text-gray-600 dark:text-gray-400 text-center">
                  {t('linkedDevices.claimAwaitingCompleteMsg')}
                </Text>
              </View>
            ) : (
              <View className="gap-3">
                <Button onPress={handleSafetyMatch} variant="primary" size="lg">
                  <Text className="text-white font-semibold">
                    {t('linkedDevices.safetyNumberMatch')}
                  </Text>
                </Button>
                <Button onPress={handleSafetyMismatch} variant="ghost" size="lg">
                  <Text className="text-red-500 font-semibold">
                    {t('linkedDevices.safetyNumberMismatch')}
                  </Text>
                </Button>
              </View>
            )}
          </View>
        )}

        {phase === 'installing' && (
          <View className="items-center py-12">
            <ActivityIndicator size="large" />
            <Text className="mt-4 text-base text-gray-700 dark:text-gray-300 text-center">
              {t('linkedDevices.claimInstallingMsg')}
            </Text>
          </View>
        )}

        {phase === 'done' && (
          <View className="items-center py-12">
            <View className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 items-center justify-center mb-4">
              <Ionicons name="checkmark" size={32} color="#22c55e" />
            </View>
            <Text className="text-lg font-semibold text-gray-900 dark:text-white text-center">
              {t('linkedDevices.claimDoneTitle')}
            </Text>
            <Text className="text-sm text-gray-600 dark:text-gray-400 text-center mt-2">
              {t('linkedDevices.claimDoneDescription')}
            </Text>
            <View className="mt-8 w-full">
              <Button onPress={handleDone} variant="primary" size="lg">
                <Text className="text-white font-semibold">{t('common.ok')}</Text>
              </Button>
            </View>
          </View>
        )}

        {phase === 'error' && (
          <View className="items-center py-12">
            <View className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900 items-center justify-center mb-4">
              <Ionicons name="alert" size={32} color="#ef4444" />
            </View>
            <Text className="text-base text-gray-900 dark:text-white text-center">
              {errorText}
            </Text>
            <View className="mt-6 gap-3 w-full">
              <Button onPress={handleRetry} variant="primary" size="lg">
                <Text className="text-white font-semibold">
                  {t('linkedDevices.primaryRetry')}
                </Text>
              </Button>
              <Button onPress={handleCancel} variant="ghost" size="md">
                <Text className="text-gray-500">{t('common.cancel')}</Text>
              </Button>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
