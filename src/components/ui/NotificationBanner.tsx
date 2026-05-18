import React, { useEffect, useRef, useCallback } from 'react';
import { Text, View, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useSegments } from 'expo-router';
import i18next from 'i18next';

import { useAppStore, NotificationBannerData } from '@/stores/app.store';
import { useAuthStore } from '@/stores/auth.store';
import { Avatar } from '@/components/ui/Avatar';

const BANNER_HEIGHT = 72;
const AUTO_DISMISS_MS = 4000;
const SWIPE_THRESHOLD = -30;

function formatPreview(body: string, messageType?: string): string {
  switch (messageType) {
    case 'ephemeral_image':
      return i18next.t('chat.ephemeralImage');
    case 'image':
    case 'persistent_image':
      return i18next.t('chat.image');
    case 'audio':
      return i18next.t('chat.audio');
    case 'location':
      return i18next.t('chat.location');
    case 'file':
      return i18next.t('chat.file');
  }

  // Fallback: detect JSON payloads that aren't displayable text
  if (body.startsWith('{') && body.includes('"')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.filePath || parsed.base64 || parsed.mediaId) {
        return i18next.t('chat.image');
      }
    } catch {}
  }

  if (body.length > 60) {
    return body.slice(0, 60) + '...';
  }

  return body;
}

export function NotificationBanner() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const segments = useSegments();
  const banner = useAppStore((s) => s.notificationBanner);
  const isInBackground = useAppStore((s) => s.isInBackground);
  const dismissBanner = useAppStore((s) => s.dismissNotificationBanner);
  const isBiometricAuthenticated = useAuthStore((s) => s.isBiometricAuthenticated);

  const hiddenY = -(BANNER_HEIGHT + insets.top + 20);
  const translateY = useSharedValue(hiddenY);
  const isVisible = useRef(false);

  // Keep a snapshot of the banner data for rendering during exit animation.
  // When dismiss() clears the store, this ref preserves the text content
  // so React doesn't re-render the Text nodes while reanimated is still
  // animating the view's transform on the UI thread.
  const displayData = useRef<NotificationBannerData | null>(null);

  const onHideComplete = useCallback(() => {
    displayData.current = null;
    dismissBanner();
  }, [dismissBanner]);

  const dismiss = useCallback(() => {
    if (!isVisible.current) return;
    isVisible.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    translateY.value = withTiming(
      -(BANNER_HEIGHT + insets.top + 20),
      { duration: 250 },
      (finished) => {
        if (finished) {
          runOnJS(onHideComplete)();
        }
      }
    );
  }, [onHideComplete, insets.top, translateY]);

  const handleTap = useCallback(
    (roomId: number) => {
      dismiss();
      if (segments[0] === 'chat') {
        router.replace(`/chat/${roomId}`);
      } else {
        router.push(`/chat/${roomId}`);
      }
    },
    [dismiss, router, segments]
  );

  // Show/hide based on banner data
  useEffect(() => {
    if (!banner || isInBackground || !isBiometricAuthenticated) {
      if (isVisible.current) {
        dismiss();
      }
      return;
    }

    // Snapshot the data for stable rendering during animations
    displayData.current = banner;

    // Show banner
    isVisible.current = true;
    translateY.value = withSpring(0, { damping: 20, stiffness: 300 });

    // Reset auto-dismiss timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      dismiss();
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [banner?.timestamp, isInBackground, isBiometricAuthenticated]);

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 0])
    .failOffsetX([-20, 20])
    .onEnd((event) => {
      if (event.translationY < SWIPE_THRESHOLD) {
        runOnJS(dismiss)();
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  // Sync ref during render so text is immediately visible.
  // When banner is dismissed (null), the ref preserves old data for exit animation.
  if (banner) {
    displayData.current = banner;
  }
  const data = displayData.current;
  const preview = data ? formatPreview(data.messagePreview, data.messageType) : '';

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[
          styles.container,
          { paddingTop: insets.top + 8 },
          animatedStyle,
        ]}
        pointerEvents={banner ? 'auto' : 'none'}
      >
        <Pressable
          style={styles.content}
          onPress={() => data && handleTap(data.roomId)}
        >
          <Avatar
            name={data?.senderName || data?.roomName}
            size="sm"
            userId={data?.roomId}
          />
          <View style={styles.textContainer}>
            <Text style={styles.roomName} numberOfLines={1}>
              {data?.roomName}
            </Text>
            <Text style={styles.preview} numberOfLines={1}>
              {data?.senderName ? `${data.senderName}: ` : ''}
              {preview}
            </Text>
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    paddingHorizontal: 8,
    paddingBottom: 12,
    backgroundColor: '#1f2937',
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  textContainer: {
    flex: 1,
    marginLeft: 10,
  },
  roomName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  preview: {
    color: '#9ca3af',
    fontSize: 13,
    marginTop: 2,
  },
});
