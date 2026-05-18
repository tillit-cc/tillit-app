import { View, Text, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/components/ui/Button';
import { useTranslation } from 'react-i18next';

export default function UnsecureScreen() {
  const { t } = useTranslation();

  const handleOpenSettings = () => {
    Linking.openSettings();
  };

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900">
      <View className="flex-1 items-center justify-center px-8">
        {/* Warning icon */}
        <View className="w-24 h-24 rounded-full bg-red-100 dark:bg-red-900/20 items-center justify-center mb-8">
          <Ionicons name="warning" size={48} color="#ef4444" />
        </View>

        {/* Title */}
        <Text className="text-2xl font-bold text-gray-900 dark:text-white text-center mb-2">
          {t('unsecure.title')}
        </Text>

        {/* Description */}
        <Text className="text-base text-gray-500 dark:text-gray-400 text-center mb-4">
          {t('unsecure.description')}
        </Text>

        {/* Additional info */}
        <View className="bg-red-50 dark:bg-red-900/10 rounded-xl p-4 mb-8 w-full max-w-sm">
          <View className="flex-row items-start">
            <Ionicons name="information-circle" size={20} color="#ef4444" />
            <Text className="ml-2 text-sm text-red-600 dark:text-red-400 flex-1">
              {t('unsecure.warning')}
            </Text>
          </View>
        </View>

        {/* Open settings button */}
        <Button
          onPress={handleOpenSettings}
          size="lg"
          icon={<Ionicons name="settings" size={20} color="#fff" />}
          className="w-full max-w-xs"
        >
          {t('unsecure.openSettings')}
        </Button>

        {/* Security requirements */}
        <View className="mt-8 w-full max-w-sm">
          <Text className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            {t('unsecure.enablePrompt')}
          </Text>

          <View className="gap-2">
            <View className="flex-row items-center">
              <View className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 items-center justify-center">
                <Ionicons name="key" size={14} color="#6b7280" />
              </View>
              <Text className="ml-3 text-sm text-gray-600 dark:text-gray-400">
                {t('unsecure.passcode')}
              </Text>
            </View>

            <View className="flex-row items-center">
              <View className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 items-center justify-center">
                <Ionicons name="finger-print" size={14} color="#6b7280" />
              </View>
              <Text className="ml-3 text-sm text-gray-600 dark:text-gray-400">
                {t('unsecure.touchId')}
              </Text>
            </View>

            <View className="flex-row items-center">
              <View className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 items-center justify-center">
                <Ionicons name="scan" size={14} color="#6b7280" />
              </View>
              <Text className="ml-3 text-sm text-gray-600 dark:text-gray-400">
                {t('unsecure.faceId')}
              </Text>
            </View>
          </View>
        </View>

        {/* Footer */}
        <View className="absolute bottom-8 left-8 right-8">
          <Text className="text-xs text-gray-400 dark:text-gray-500 text-center">
            {t('unsecure.footer')}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}
