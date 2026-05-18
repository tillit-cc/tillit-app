import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/auth.store';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';

export default function LockedScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { setBiometricAuthenticated, logout } = useAuthStore();
  const { authenticate, isLoading, error } = useBiometricAuth();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const hasAutoTriggered = useRef(false);

  const handleUnlock = useCallback(async () => {
    if (isAuthenticating) return;

    setIsAuthenticating(true);
    try {
      const success = await authenticate(t('locked.unlockPrompt'));

      if (success) {
        // Set biometric authenticated - _layout.tsx will handle redirect to /(tabs)
        setBiometricAuthenticated(true);
      } else {
        Alert.alert(t('common.error'), error || t('auth.authFailed'));
      }
    } catch (e) {
      Alert.alert(t('common.error'), t('locked.unexpectedError'));
    } finally {
      setIsAuthenticating(false);
    }
  }, [authenticate, setBiometricAuthenticated, error, isAuthenticating]);

  // Auto-trigger biometric once the hook's initial state check is done
  useEffect(() => {
    if (!isLoading && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      handleUnlock();
    }
  }, [isLoading, handleUnlock]);

  const handleLogout = useCallback(async () => {
    Alert.alert(
      t('locked.signOutTitle'),
      t('locked.signOutMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('locked.signOut'),
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  }, [logout, router]);

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900">
      <View className="flex-1 items-center justify-center px-8">
        {/* Lock icon */}
        <View className="w-24 h-24 rounded-full bg-blue-100 dark:bg-blue-900/20 items-center justify-center mb-8">
          <Ionicons name="lock-closed" size={48} color="#3b82f6" />
        </View>

        {/* Title */}
        <Text className="text-2xl font-bold text-gray-900 dark:text-white text-center mb-2">
          {t('locked.title')}
        </Text>

        {/* Description */}
        <Text className="text-base text-gray-500 dark:text-gray-400 text-center mb-8">
          {t('locked.description')}
        </Text>

        {/* Unlock button */}
        <Button
          onPress={handleUnlock}
          loading={isAuthenticating || isLoading}
          size="lg"
          icon={<Ionicons name="finger-print" size={20} color="#fff" />}
          className="w-full max-w-xs"
        >
          {t('locked.unlock')}
        </Button>

        {/* Error message */}
        {error && (
          <Text className="mt-4 text-sm text-red-500 text-center">{error}</Text>
        )}

        {/* Logout option */}
        <Button
          variant="ghost"
          onPress={handleLogout}
          className="mt-6"
        >
          {t('locked.signOut')}
        </Button>

        {/* Security info */}
        <View className="absolute bottom-8 left-8 right-8">
          <View className="flex-row items-center justify-center">
            <Ionicons name="shield-checkmark" size={16} color="#22c55e" />
            <Text className="ml-2 text-sm text-gray-400 dark:text-gray-500 text-center">
              {t('locked.footer')}
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
