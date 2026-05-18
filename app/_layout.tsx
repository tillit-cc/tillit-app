import '@/i18n';
import { useEffect, useRef } from 'react';
import { LogBox, View } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as ScreenCapture from 'expo-screen-capture';
import * as SplashScreen from 'expo-splash-screen';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import 'react-native-reanimated';
import '../global.css';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { useChatStore } from '@/stores/chat.store';
import { useServerStore } from '@/stores/server.store';
import { toLocalRoomId, toBackendRoomId } from '@/utils/server-id';
import { NotificationBanner } from '@/components/ui/NotificationBanner';

// Suppress warnings from third-party dependencies that we cannot fix directly.
// - SafeAreaView: react-native-css-interop (NativeWind) registers the deprecated
//   RN SafeAreaView at import time. Will be fixed in NativeWind v5.
LogBox.ignoreLogs([
  'SafeAreaView has been deprecated',
]);

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadStoredToken = useAuthStore((s) => s.loadStoredToken);

  useEffect(() => {
    async function prepare() {
      try {
        await loadStoredToken();
      } finally {
        await SplashScreen.hideAsync();
      }
    }

    prepare();
  }, [loadStoredToken]);

  // ShareIntentProvider must be mounted immediately (before auth loading completes)
  // so it can capture the initial deep link URL from the Share Extension.
  // If gated behind isLoading, the URL arrives before the provider mounts and is lost.
  return (
    <ShareIntentProvider options={{ debug: __DEV__, resetOnBackground: false }}>
      {isLoading ? (
        <View style={{ flex: 1 }} />
      ) : (
        <RootNavigator />
      )}
    </ShareIntentProvider>
  );
}

function RootNavigator() {
  const colorScheme = useColorScheme();
  const segments = useSegments();
  const router = useRouter();
  const { hasShareIntent } = useShareIntentContext();
  const shareIntentRouted = useRef(false);
  const pendingInviteCode = useAppStore((s) => s.pendingInviteCode);
  const pendingNotificationRoomId = useAppStore((s) => s.pendingNotificationRoomId);

  // Handle notification tap (cold start + warm start)
  const lastNotificationResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!lastNotificationResponse) return;
    const data = lastNotificationResponse.notification.request.content.data;
    const rawRoomId = data?.roomId ? Number(data.roomId) : null;
    if (rawRoomId) {
      // If the notification includes serverUrl (added by the notification service),
      // find the matching local server and compute the exact local room ID.
      // Otherwise fall back to fuzzy matching for backward compatibility.
      const serverUrl = data?.serverUrl as string | undefined;
      let resolvedId: number;
      if (serverUrl) {
        const servers = useServerStore.getState().servers;
        const server = servers.find(s => s.apiUrl === serverUrl);
        resolvedId = server ? toLocalRoomId(server.id, rawRoomId) : rawRoomId;
      } else {
        const allRooms = useChatStore.getState().allRooms;
        const match = allRooms.find(r => r.id === rawRoomId || toBackendRoomId(r.id) === rawRoomId);
        resolvedId = match?.id ?? rawRoomId;
      }
      useAppStore.getState().setPendingNotificationRoomId(resolvedId);
    }
  }, [lastNotificationResponse]);

  // Use individual selectors to avoid re-rendering on every unrelated state change.
  // Without selectors, useAuthStore() returns the full state which changes reference
  // on every set() call, causing unnecessary re-renders during loadStoredToken().
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isBiometricAuthenticated = useAuthStore((s) => s.isBiometricAuthenticated);
  const isDeviceSecure = useAuthStore((s) => s.isDeviceSecure);

  // Prevent screenshots when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      ScreenCapture.preventScreenCaptureAsync();
    } else {
      ScreenCapture.allowScreenCaptureAsync();
    }
  }, [isAuthenticated]);

  // Redirect based on auth state.
  //
  // IMPORTANT: segments is intentionally NOT in the dependency array.
  // useSegments() is backed by useSyncExternalStore (expo-router internals).
  // If segments were a dependency, router.replace() would update the navigation
  // state → useSyncExternalStore triggers a synchronous re-render → segments
  // changes → effect re-fires → router.replace() again → infinite loop.
  // On iOS this doesn't manifest because navigation state settles within the
  // same tick; on Android the state transitions are async, causing oscillation.
  //
  // The effect is driven solely by auth state changes. segments[0] is read
  // inside the body to guard against unnecessary redirects (e.g., don't redirect
  // to login if already on login), using the value from the current render.
  // Reset the flag when the share intent is consumed
  useEffect(() => {
    if (!hasShareIntent) shareIntentRouted.current = false;
  }, [hasShareIntent]);

  useEffect(() => {
    if (isLoading) return;

    const rootSegment = segments[0];
    const inAuthGroup = rootSegment === '(auth)';
    const inLockedRoute = rootSegment === 'locked';
    const inUnsecureRoute = rootSegment === 'unsecure';
    const inShareTarget = rootSegment === 'share-target';
    const inJoinRoom = rootSegment === 'join-room';

    if (!isDeviceSecure && !inUnsecureRoute) {
      router.replace('/unsecure');
    } else if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && !isBiometricAuthenticated && !inLockedRoute && !inAuthGroup) {
      // Push locked screen on top — preserves the navigation stack so that
      // after biometric unlock we can pop back to exactly where the user was
      // (e.g., a chat room). Security is maintained: if the user presses the
      // Android back button, they land on the previous route but the redirect
      // effect re-fires (isBiometricAuthenticated is still false) and pushes
      // /locked again immediately.
      router.navigate('/locked');
    } else if (isAuthenticated && isBiometricAuthenticated) {
      if (inAuthGroup || inLockedRoute || inUnsecureRoute) {
        // User completed auth flow — redirect to appropriate destination
        if (hasShareIntent && !shareIntentRouted.current) {
          shareIntentRouted.current = true;
          router.replace('/share-target');
        } else if (pendingInviteCode) {
          router.replace('/join-room');
        } else if (pendingNotificationRoomId) {
          useAppStore.getState().setPendingNotificationRoomId(null);
          // Always go through tabs for a clean stack: /(tabs) → /chat/[id].
          // Avoids stacking chat screens (e.g. tabs/chat/old/chat/new).
          router.replace('/(tabs)');
          setTimeout(() => router.push(`/chat/${pendingNotificationRoomId}`), 0);
        } else if (inLockedRoute && router.canGoBack()) {
          // Biometric unlock after background resume — pop the locked screen
          // to restore the previous navigation stack (e.g., return to the
          // chat room the user was in). Avoids /(tabs) duplication.
          router.back();
        } else {
          router.replace('/(tabs)');
        }
      } else if (hasShareIntent && !inShareTarget && !shareIntentRouted.current) {
        // Share intent arrived while already authenticated.
        // On warm start, +native-intent.ts already navigated to /share-target
        // (initial=false), so inShareTarget should be true and this branch
        // won't execute. This branch is a fallback for edge cases where
        // segments haven't updated yet or the intent arrived via a different path.
        shareIntentRouted.current = true;
        router.navigate('/share-target');
      } else if (pendingInviteCode && !inJoinRoom) {
        // Deep link arrived while already authenticated.
        // Use navigate (not push) to avoid stacking duplicate entries.
        router.navigate('/join-room');
      } else if (pendingNotificationRoomId) {
        // Notification tap while already authenticated.
        // If on a chat screen, replace to avoid stacking; otherwise push.
        useAppStore.getState().setPendingNotificationRoomId(null);
        if (rootSegment === 'chat') {
          router.replace(`/chat/${pendingNotificationRoomId}`);
        } else {
          router.push(`/chat/${pendingNotificationRoomId}`);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isAuthenticated, isBiometricAuthenticated, isDeviceSecure, hasShareIntent, pendingInviteCode, pendingNotificationRoomId]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false, headerBackTitle: 'TilliT' }} />
            <Stack.Screen name="locked" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="unsecure" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen
              name="chat/[id]"
              options={{
                headerShown: true,
                presentation: 'card',
              }}
            />
            <Stack.Screen
              name="share-target"
              options={{
                headerShown: false,
                presentation: 'modal',
              }}
            />
            <Stack.Screen
              name="join-room"
              options={{
                headerShown: false,
                presentation: 'modal',
              }}
            />
          </Stack>
          <NotificationBanner />
          <StatusBar style="auto" />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
