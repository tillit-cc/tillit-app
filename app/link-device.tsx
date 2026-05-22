import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  Alert,
  Pressable,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Button } from '@/components/ui/Button';
import { useDeviceStore } from '@/stores/device.store';
import { useAppStore } from '@/stores/app.store';
import { deviceService } from '@/services/device.service';
import { logger } from '@/utils/logger';

/**
 * Primary side (wire v2): scan the QR shown by the new device, validate
 * that it targets our server, confirm the safety number with the user
 * out-of-band, and complete the pairing.
 *
 * Phase machine (mirrors `pairingPrimary` in device.store):
 *   - (no pairing in flight) → camera scanner
 *   - scanning      → camera open OR spinner if computing safety from a deep link
 *   - safetyCheck   → safety number + Match / Don't match
 *   - completing    → spinner ("Completing the link…")
 *   - done          → success → back to profile
 *   - error         → message + Retry
 */
export default function LinkDeviceScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const pairing = useDeviceStore((s) => s.pairingPrimary);
  const [permission, requestPermission] = useCameraPermissions();
  const [scannerActive, setScannerActive] = useState(true);
  const scanLockRef = useRef(false);

  // Bring up the primary pairing slot on mount so the scanner is in a
  // known state. Clean up on unmount unless we landed in `done`.
  useEffect(() => {
    if (!useDeviceStore.getState().pairingPrimary) {
      useDeviceStore.getState().startPrimaryScan();
    }
    return () => {
      const currentPhase = useDeviceStore.getState().pairingPrimary?.phase;
      if (currentPhase && currentPhase !== 'done') {
        deviceService.cancelPrimaryPairing();
      } else {
        useDeviceStore.getState().clearPrimaryPairing();
      }
    };
  }, []);

  // Camera permission: ask once.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // If the user arrived via a `tillit://link?...` deep link, drive the
  // primary flow without opening the camera. The URL was parked in
  // app.store by +native-intent.
  useEffect(() => {
    const pendingLink = useAppStore.getState().pendingPrimaryScanLink;
    if (!pendingLink || scanLockRef.current) return;
    useAppStore.getState().setPendingPrimaryScanLink(null);
    const parsed = deviceService.parseProvisioningLink(pendingLink);
    if (!parsed) {
      Alert.alert(t('common.error'), t('linkedDevices.errorInvalidQR'));
      return;
    }
    scanLockRef.current = true;
    setScannerActive(false);
    deviceService.handlePrimaryScannedQR(parsed).catch((err) => {
      logger.warn('[LinkDevice] handlePrimaryScannedQR (deep link) error:', err?.message ?? err);
    });
    // Intentionally only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Scanner callback ----------
  // Identity-stable callback for CameraView. expo-camera@55 wires
  // `onBarcodeScanned` once on mount; if the prop changes identity between
  // renders the native binding can fail to attach, so we keep one
  // ref-based dispatcher whose closure never changes.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  const handleScan = useCallback(({ data }: { data: string }) => {
    if (scanLockRef.current) return;
    const _t = tRef.current;
    logger.info('[LinkDevice] scanner read barcode (len=' + (data?.length ?? 0) + '): ' + (data?.slice(0, 80) ?? ''));
    const parsed = deviceService.parseProvisioningLink(data);
    if (!parsed) {
      logger.warn('[LinkDevice] scanner read non-provisioning code, ignoring');
      Alert.alert(_t('common.error'), _t('linkedDevices.errorInvalidQR'));
      return;
    }
    scanLockRef.current = true;
    setScannerActive(false);
    deviceService.handlePrimaryScannedQR(parsed).catch((err) => {
      logger.warn('[LinkDevice] handlePrimaryScannedQR error:', err);
    });
  }, []);

  // Identity-stable settings. Same reason as the callback above.
  const scannerSettings = useMemo(() => ({ barcodeTypes: ['qr'] as BarcodeType[] }), []);

  // ---------- Handlers ----------
  const handleSafetyMatch = useCallback(async () => {
    try {
      await deviceService.confirmPrimarySafetyAndComplete();
    } catch (err) {
      logger.warn('[LinkDevice] complete failed:', err);
    }
  }, []);

  const handleSafetyMismatch = useCallback(() => {
    Alert.alert(
      t('linkedDevices.safetyNumberMismatchConfirmTitle'),
      t('linkedDevices.safetyNumberMismatchConfirmMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('linkedDevices.safetyNumberMismatchConfirmAction'),
          style: 'destructive',
          onPress: () => {
            deviceService.cancelPrimaryPairing();
            router.back();
          },
        },
      ],
    );
  }, [t, router]);

  const handleCancel = useCallback(() => {
    deviceService.cancelPrimaryPairing();
    router.back();
  }, [router]);

  const handleDone = useCallback(() => {
    useDeviceStore.getState().clearPrimaryPairing();
    deviceService.loadDevices().catch(() => undefined);
    router.back();
  }, [router]);

  const handleRetry = useCallback(() => {
    useDeviceStore.getState().clearPrimaryPairing();
    useDeviceStore.getState().startPrimaryScan();
    scanLockRef.current = false;
    setScannerActive(true);
  }, []);

  // ---------- Error message mapping ----------
  const errorText = useMemo(() => {
    if (!pairing?.errorMessage) return null;
    switch (pairing.errorMessage) {
      case 'SERVER_MISMATCH':
        return t('linkedDevices.errorServerMismatch');
      case 'DEVICE_LIMIT_REACHED':
        return t('linkedDevices.errorDeviceLimit');
      case 'TOO_MANY_LINKS':
        return t('linkedDevices.errorTooManyLinks');
      case 'SESSION_EXPIRED':
      case 'POLL_TIMEOUT':
        return t('linkedDevices.errorTokenExpired');
      case 'SESSION_NOT_FOUND':
        return t('linkedDevices.errorTokenNotFound');
      case 'PUBKEY_MISMATCH':
        return t('linkedDevices.errorPubkeyMismatch');
      case 'SHARE_PUBKEY_FAILED':
      case 'SESSION_NOT_PUBKEY_SHARED':
        return t('linkedDevices.errorGeneric');
      default:
        return t('linkedDevices.errorGeneric');
    }
  }, [pairing?.errorMessage, t]);

  const phase = pairing?.phase ?? null;

  // ---------- Header ----------
  const header = (
    <View className="flex-row items-center justify-between px-4 py-3 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800">
      <Text className="text-lg font-semibold text-gray-900 dark:text-white">
        {t('linkedDevices.primaryTitle')}
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

  // Permission denied → ask the user to open Settings
  if (permission && !permission.granted && !permission.canAskAgain) {
    return (
      <SafeAreaView className="flex-1 bg-gray-50 dark:bg-gray-950" edges={['top', 'bottom']}>
        {header}
        <View className="flex-1 items-center justify-center p-6">
          <Ionicons name="videocam-off-outline" size={48} color="#ef4444" />
          <Text className="mt-4 text-base text-gray-900 dark:text-white text-center">
            {t('linkedDevices.claimCameraPermission')}
          </Text>
          <Text className="mt-2 text-sm text-gray-600 dark:text-gray-400 text-center">
            {t('linkedDevices.claimCameraPermissionMsg')}
          </Text>
          <View className="mt-6 w-full">
            <Button onPress={() => Linking.openSettings()} variant="primary" size="lg">
              <Text className="text-white font-semibold">
                {t('linkedDevices.claimCameraOpenSettings')}
              </Text>
            </Button>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Scanner view (default state, no pairing in flight or scanning phase)
  if (!phase || phase === 'idle' || (phase === 'scanning' && scannerActive)) {
    return (
      <SafeAreaView className="flex-1 bg-black" edges={['top', 'bottom']}>
        {header}
        <View className="flex-1">
          {permission?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={scannerSettings}
              onBarcodeScanned={handleScan}
              onCameraReady={() => logger.info('[LinkDevice] CameraView ready')}
              onMountError={(e) => logger.warn('[LinkDevice] CameraView mount error: ' + (e?.message ?? ''))}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color="#ffffff" />
            </View>
          )}
          <View className="absolute inset-x-0 bottom-0 p-6 bg-black/50">
            <Text className="text-white text-center text-base">
              {t('linkedDevices.primaryScannerHint')}
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Phase-specific bodies inside the standard chrome
  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-gray-950" edges={['top', 'bottom']}>
      {header}
      <View className="flex-1 p-4">
        {phase === 'scanning' && !scannerActive && (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
            <Text className="mt-4 text-base text-gray-700 dark:text-gray-300 text-center">
              {t('linkedDevices.primaryStartingMsg')}
            </Text>
          </View>
        )}

        {phase === 'safetyCheck' && pairing?.safetyNumber && (
          <View>
            <Text className="text-base font-semibold text-gray-900 dark:text-white text-center mt-4">
              {t('linkedDevices.primaryClaimedTitle')}
            </Text>
            <Text className="text-sm text-gray-600 dark:text-gray-400 text-center mt-2 mb-6">
              {t('linkedDevices.primaryClaimedDescription')}
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
          </View>
        )}

        {phase === 'completing' && (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
            <Text className="mt-4 text-base text-gray-700 dark:text-gray-300 text-center">
              {t('linkedDevices.primaryCompletingMsg')}
            </Text>
          </View>
        )}

        {phase === 'done' && (
          <View className="flex-1 items-center justify-center">
            <View className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 items-center justify-center mb-4">
              <Ionicons name="checkmark" size={32} color="#22c55e" />
            </View>
            <Text className="text-lg font-semibold text-gray-900 dark:text-white text-center">
              {t('linkedDevices.primaryDoneTitle')}
            </Text>
            <Text className="text-sm text-gray-600 dark:text-gray-400 text-center mt-2">
              {t('linkedDevices.primaryDoneDescription')}
            </Text>
            <View className="mt-8 w-full">
              <Button onPress={handleDone} variant="primary" size="lg">
                <Text className="text-white font-semibold">{t('common.ok')}</Text>
              </Button>
            </View>
          </View>
        )}

        {phase === 'error' && (
          <View className="flex-1 items-center justify-center">
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
      </View>
    </SafeAreaView>
  );
}
