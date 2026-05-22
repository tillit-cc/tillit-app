import { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, Alert, Linking, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { useDeviceStore } from '@/stores/device.store';
import { appInitService } from '@/services/app-init.service';
import { deviceService } from '@/services/device.service';
import { profileRepository } from '@/db/repositories/profile.repository';
import { logger } from '@/utils/logger';
import type { DeviceInfo } from '@/types/device';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';

const PRIVACY_POLICY_URL = 'https://tillit.cc/privacy-policy.html';

export default function ProfileScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { userId } = useAuthStore();
  const { settings, updateSettings } = useAppStore();
  const [username, setUsername] = useState(settings.username || '');
  const [isDeleting, setIsDeleting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const version = Application.nativeApplicationVersion || '-';
  const buildNumber = Application.nativeBuildVersion || '-';

  const handleUsernameChange = useCallback(
    (value: string) => {
      setUsername(value);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        updateSettings({ username: value });
        if (userId) {
          profileRepository.upsert({
            idUser: userId,
            idRoom: null as any,
            username: value,
          }).catch((err) => logger.warn('[Profile] DB save error:', err));
        }
        logger.info('[Profile] Username saved');
      }, 300);
    },
    [updateSettings, userId]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleLogout = () => {
    Alert.alert(t('profile.signOut'), t('profile.signOutMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.signOut'),
        style: 'destructive',
        onPress: async () => {
          await appInitService.logout();
        },
      },
    ]);
  };

  const handleOpenPrivacyPolicy = useCallback(async () => {
    try {
      const supported = await Linking.canOpenURL(PRIVACY_POLICY_URL);
      if (!supported) {
        Alert.alert(t('common.error'), t('profile.privacyPolicyError'));
        return;
      }
      await Linking.openURL(PRIVACY_POLICY_URL);
    } catch (error) {
      logger.warn('[Profile] Failed to open privacy policy:', error);
      Alert.alert(t('common.error'), t('profile.privacyPolicyError'));
    }
  }, [t]);

  // ===== Linked devices =====
  const devices = useDeviceStore((s) => s.devices);
  const loadingDevices = useDeviceStore((s) => s.loadingDevices);

  useEffect(() => {
    deviceService.loadDevices().catch((err) => {
      logger.warn('[Profile] loadDevices failed:', err?.message ?? err);
    });
  }, []);

  const handleLinkNewDevice = useCallback(() => {
    router.push('/link-device');
  }, [router]);

  const handleRevokeDevice = useCallback(
    (device: DeviceInfo) => {
      if (device.isPrimary) return;
      Alert.alert(
        t('linkedDevices.revokeTitle'),
        t('linkedDevices.revokeMsg', { name: device.deviceName }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('linkedDevices.revoke'),
            style: 'destructive',
            onPress: async () => {
              try {
                await deviceService.revokeDevice(device.deviceId);
              } catch (err) {
                logger.warn('[Profile] revokeDevice failed:', err);
                Alert.alert(t('common.error'), t('linkedDevices.revokeError'));
              }
            },
          },
        ],
      );
    },
    [t],
  );

  const formatLastSeen = useCallback(
    (iso: string | null): string => {
      if (!iso) return t('linkedDevices.lastSeenNever');
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return iso;
      }
    },
    [t],
  );

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      t('profile.deleteAccountTitle'),
      t('profile.deleteAccountMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profile.deleteAccountConfirm'),
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            try {
              const { failedServers } = await appInitService.deleteAccount();

              if (failedServers.length > 0) {
                Alert.alert(
                  t('profile.deleteAccountPartialTitle'),
                  t('profile.deleteAccountPartialMsg', { count: failedServers.length }),
                  [{ text: t('common.ok'), onPress: () => router.replace('/(auth)/login') }],
                );
              } else {
                router.replace('/(auth)/login');
              }
            } catch (error) {
              logger.error('[Profile] deleteAccount error:', error);
              setIsDeleting(false);
              Alert.alert(t('common.error'), t('profile.deleteAccountError'));
            }
          },
        },
      ],
    );
  }, [t, router]);

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-gray-950" edges={['bottom']}>
      <ScrollView>
        {/* Profile Avatar */}
        <View className="items-center py-8 bg-white dark:bg-gray-900">
          <View className="w-20 h-20 rounded-full bg-gray-200 dark:bg-gray-700 items-center justify-center">
            <Ionicons name="person" size={40} color="#9ca3af" />
          </View>
        </View>

        {/* Username Section */}
        <View className="mt-4 bg-white dark:bg-gray-900 px-4 py-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            {t('profile.yourName')}
          </Text>
          <Text className="text-xs text-gray-400 dark:text-gray-500 mb-3">
            {t('profile.nameDescription')}
          </Text>
          <TextInput
            value={username}
            onChangeText={handleUsernameChange}
            placeholder={t('profile.namePlaceholder')}
            placeholderTextColor="#9ca3af"
            className="text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-800 rounded-lg px-4 py-3"
          />
        </View>

        {/* Info Section */}
        <View className="mt-4 bg-white dark:bg-gray-900 px-4 py-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
            {t('profile.appInfo')}
          </Text>
          <View className="flex-row justify-between py-2">
            <Text className="text-base text-gray-500 dark:text-gray-400">{t('profile.version')}</Text>
            <Text className="text-base text-gray-900 dark:text-white">{version}</Text>
          </View>
          <View className="flex-row justify-between py-2">
            <Text className="text-base text-gray-500 dark:text-gray-400">Build</Text>
            <Text className="text-base text-gray-900 dark:text-white">{buildNumber}</Text>
          </View>
          {Updates.channel ? (
            <View className="flex-row justify-between py-2">
              <Text className="text-base text-gray-500 dark:text-gray-400">{t('profile.channel')}</Text>
              <Text className="text-base text-gray-900 dark:text-white">{Updates.channel}</Text>
            </View>
          ) : null}
          {Updates.updateId ? (
            <View className="flex-row justify-between py-2">
              <Text className="text-base text-gray-500 dark:text-gray-400">{t('profile.update')}</Text>
              <Text className="text-base text-gray-900 dark:text-white">
                {Updates.updateId.slice(0, 8)}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Linked devices Section */}
        <View className="mt-4 bg-white dark:bg-gray-900 px-4 py-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            {t('linkedDevices.section')}
          </Text>
          <Text className="text-xs text-gray-400 dark:text-gray-500 mb-3">
            {t('linkedDevices.sectionDescription')}
          </Text>

          {loadingDevices && devices.length === 0 ? (
            <View className="py-6 items-center">
              <ActivityIndicator />
            </View>
          ) : devices.length === 0 ? (
            <Text className="text-sm text-gray-500 dark:text-gray-400 py-2">
              {t('linkedDevices.noLinked')}
            </Text>
          ) : (
            <View>
              {devices
                .filter((d) => d.status !== 'revoked')
                .map((device) => (
                  <View
                    key={device.deviceId}
                    className="flex-row items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                  >
                    <View className="flex-1 mr-3">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-base text-gray-900 dark:text-white font-medium">
                          {device.deviceName}
                        </Text>
                        {device.isPrimary ? (
                          <View className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900 rounded">
                            <Text className="text-xs text-blue-700 dark:text-blue-300">
                              {t('linkedDevices.primaryBadge')}
                            </Text>
                          </View>
                        ) : null}
                        {device.isCurrent ? (
                          <View className="px-2 py-0.5 bg-green-100 dark:bg-green-900 rounded">
                            <Text className="text-xs text-green-700 dark:text-green-300">
                              {t('linkedDevices.thisDevice')}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t('linkedDevices.lastSeen')}: {formatLastSeen(device.lastSeen)}
                      </Text>
                    </View>
                    {!device.isPrimary && !device.isCurrent ? (
                      <Pressable
                        onPress={() => handleRevokeDevice(device)}
                        accessibilityRole="button"
                        accessibilityLabel={t('linkedDevices.revoke')}
                        className="px-3 py-2"
                        hitSlop={8}
                      >
                        <Ionicons name="trash-outline" size={20} color="#ef4444" />
                      </Pressable>
                    ) : null}
                  </View>
                ))}
            </View>
          )}

          <View className="mt-3">
            <Button
              onPress={handleLinkNewDevice}
              variant="outline"
              size="md"
              icon={<Ionicons name="qr-code-outline" size={20} color="#3b82f6" />}
            >
              <Text className="text-blue-500 font-semibold">{t('linkedDevices.linkNewDevice')}</Text>
            </Button>
          </View>
        </View>

        {/* Privacy & legal Section */}
        <View className="mt-4 bg-white dark:bg-gray-900 px-4 py-3">
          <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
            {t('profile.privacyAndLegal')}
          </Text>
          <Pressable
            onPress={handleOpenPrivacyPolicy}
            className="flex-row items-center justify-between py-3"
            accessibilityRole="link"
          >
            <View className="flex-row items-center gap-3">
              <Ionicons name="shield-checkmark-outline" size={20} color="#6b7280" />
              <Text className="text-base text-gray-900 dark:text-white">
                {t('profile.privacyPolicy')}
              </Text>
            </View>
            <Ionicons name="open-outline" size={18} color="#9ca3af" />
          </Pressable>
        </View>

        {/* Logout Section */}
        <View className="mt-4 px-4">
          <Button
            onPress={handleLogout}
            variant="outline"
            size="lg"
            disabled={isDeleting}
            icon={<Ionicons name="log-out-outline" size={20} color="#ef4444" />}
          >
            <Text className="text-red-500 font-semibold text-lg">{t('profile.signOut')}</Text>
          </Button>
        </View>

        {/* Delete account section (destructive, separated visually) */}
        <View className="mt-3 px-4 mb-8">
          <Button
            onPress={handleDeleteAccount}
            variant="ghost"
            size="lg"
            disabled={isDeleting}
            icon={<Ionicons name="trash-outline" size={20} color="#ef4444" />}
          >
            <Text className="text-red-500 font-semibold text-lg">
              {isDeleting ? t('profile.deletingAccount') : t('profile.deleteAccount')}
            </Text>
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
