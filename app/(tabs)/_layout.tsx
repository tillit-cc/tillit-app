import { useState } from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ConnectionStatusIcon } from '@/components/ui/ConnectionStatusIcon';
import { ServerStatusModal } from '@/components/modals/ServerStatusModal';

export default function TabLayout() {
  const { t } = useTranslation();
  const colorScheme = useColorScheme();
  const [showServerStatus, setShowServerStatus] = useState(false);

  return (
    <>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#2ad1af',
          tabBarInactiveTintColor: colorScheme === 'dark' ? '#6b7280' : '#9ca3af',
          tabBarStyle: {
            backgroundColor: colorScheme === 'dark' ? '#111827' : '#ffffff',
            borderTopColor: colorScheme === 'dark' ? '#1f2937' : '#e5e7eb',
          },
          headerStyle: {
            backgroundColor: colorScheme === 'dark' ? '#111827' : '#ffffff',
          },
          headerTintColor: colorScheme === 'dark' ? '#ffffff' : '#111827',
          headerShadowVisible: false,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('tabs.chat'),
            headerTitle: 'TilliT',
            headerRight: () => (
              <ConnectionStatusIcon onPress={() => setShowServerStatus(true)} />
            ),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubbles" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: t('tabs.profile'),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="person" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
      <ServerStatusModal
        visible={showServerStatus}
        onClose={() => setShowServerStatus(false)}
      />
    </>
  );
}
