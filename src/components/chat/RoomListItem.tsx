import React, { memo, useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@/components/ui/Avatar';
import { useChatStore, RoomWithMetadata } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { useServerStore } from '@/stores/server.store';
import { getMessagePreview } from '@/utils/message-preview';

const ACTION_WIDTH = 72;
const SNAP_THRESHOLD = 36;

interface RoomListItemProps {
  room: RoomWithMetadata;
  onPress: (room: RoomWithMetadata) => void;
  onDelete?: (room: RoomWithMetadata) => void;
}

/**
 * Format timestamp for room list display
 */
function formatLastTime(timestamp?: number | null): string {
  if (!timestamp) return '';

  const date = new Date(timestamp > 10000000000 ? timestamp : timestamp * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  if (date >= today) {
    return date.toLocaleTimeString(i18next.language, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  if (date >= yesterday) {
    return i18next.t('chat.yesterday');
  }

  // Within the same week
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (date >= weekAgo) {
    return date.toLocaleDateString(i18next.language, { weekday: 'short' });
  }

  // Older
  return date.toLocaleDateString(i18next.language, {
    month: 'short',
    day: 'numeric',
  });
}

export const RoomListItem = memo(function RoomListItem({
  room,
  onPress,
  onDelete,
}: RoomListItemProps) {
  const { t } = useTranslation();
  const hasUnread = (room.unreadCount ?? 0) > 0;
  const profiles = useChatStore((s) => s.profiles.get(room.id));
  const currentUserId = useAuthStore((s) => s.userId);
  const servers = useServerStore((s) => s.servers);
  const isBanned = useServerStore((s) => s.bannedServers.has(room.serverId));
  const showServerBadge = servers.length > 1;

  // For 2-person rooms, show the other participant's name.
  // profiles may contain 1 entry (only remote, syncMembers skips self)
  // or 2 entries (if self profile was also stored). Handle both.
  const displayName = useMemo(() => {
    if (!profiles || !currentUserId) return null;
    if (profiles.size > 2) return null; // Group room
    for (const [uid, profile] of profiles) {
      if (uid !== currentUserId && profile.username) {
        return profile.username;
      }
    }
    return null;
  }, [profiles, currentUserId]);
  const serverName = showServerBadge
    ? servers.find((s) => s.id === room.serverId)?.name
    : undefined;
  const translateX = useSharedValue(0);
  const contextX = useSharedValue(0);

  const closeSwipe = useCallback(() => {
    translateX.value = withTiming(0, { duration: 200 });
  }, [translateX]);

  const handlePress = useCallback(() => {
    if (translateX.value < -10) {
      // If swiped open, close instead of navigating
      closeSwipe();
      return;
    }
    onPress(room);
  }, [onPress, room, translateX, closeSwipe]);

  const handleDelete = useCallback(() => {
    closeSwipe();
    onDelete?.(room);
  }, [onDelete, room, closeSwipe]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onStart(() => {
      contextX.value = translateX.value;
    })
    .onUpdate((event) => {
      const newX = contextX.value + event.translationX;
      translateX.value = Math.max(Math.min(newX, 0), -ACTION_WIDTH);
    })
    .onEnd(() => {
      if (translateX.value < -SNAP_THRESHOLD) {
        // Snap open
        translateX.value = withTiming(-ACTION_WIDTH, { duration: 200 });
      } else {
        // Snap closed
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const actionStyle = useAnimatedStyle(() => ({
    width: Math.abs(Math.min(translateX.value, 0)),
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={styles.container}>
        {/* Delete action behind */}
        <Animated.View style={[styles.actionContainer, actionStyle]}>
          <Pressable onPress={handleDelete} style={styles.deleteButton}>
            <View style={styles.deleteCircle}>
              <Ionicons name="trash" size={20} color="#213649" />
            </View>
          </Pressable>
        </Animated.View>

        {/* Room item */}
        <Animated.View style={[styles.itemWrapper, animatedStyle]}>
          <Pressable
            onPress={handlePress}
            className="flex-row items-center px-4 py-3 bg-white dark:bg-gray-900 active:bg-gray-50 dark:active:bg-gray-800"
          >
            {/* Avatar */}
            <Avatar name={displayName || room.name} userId={room.id} size="lg" />

            {/* Content */}
            <View className="flex-1 ml-3">
              {/* Room name and time */}
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center flex-1">
                  <Text
                    className={`text-base ${
                      hasUnread
                        ? 'font-semibold text-gray-900 dark:text-white'
                        : 'font-medium text-gray-900 dark:text-white'
                    }`}
                    numberOfLines={1}
                  >
                    {displayName || room.name || t('chat.roomFallback', { id: room.id })}
                  </Text>
                  {serverName && (
                    <View className={`ml-1.5 rounded px-1 py-0.5 ${isBanned ? 'bg-red-100 dark:bg-red-900/30' : 'bg-gray-200 dark:bg-gray-700'}`}>
                      <Text className={`text-[10px] ${isBanned ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>{serverName}</Text>
                    </View>
                  )}
                </View>
                <Text className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                  {formatLastTime(room.lastMessageTime || room.timestampCreate)}
                </Text>
              </View>

              {/* Room name subtitle (shown when displaying participant name instead of room name) */}
              {displayName && room.name ? (
                <Text className="text-xs text-gray-400 dark:text-gray-500" numberOfLines={1}>
                  {room.name}
                </Text>
              ) : null}

              {/* Last message and unread badge */}
              <View className="flex-row items-center justify-between mt-0.5">
                <Text
                  className={`text-sm flex-1 ${
                    hasUnread
                      ? 'font-medium text-gray-700 dark:text-gray-300'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                  numberOfLines={1}
                >
                  {getMessagePreview(room.lastMessageText, room.lastMessageType, { fallback: '' }) || (!room.hasSession ? t('chat.waitingSession') : t('chat.noMessages'))}
                </Text>

                {hasUnread && (
                  <View className="ml-2 rounded-full min-w-[20px] h-5 px-1.5 items-center justify-center" style={{ backgroundColor: '#2ad1af' }}>
                    <Text className="text-xs font-semibold text-white">
                      {room.unreadCount! > 99 ? '99+' : room.unreadCount}
                    </Text>
                  </View>
                )}

                {!room.hasSession && !hasUnread && (
                  <Ionicons name="time-outline" size={16} color="#9ca3af" className="ml-2" />
                )}
              </View>
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  itemWrapper: {
    zIndex: 1,
  },
  actionContainer: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    overflow: 'hidden',
    zIndex: 0,
  },
  deleteButton: {
    width: ACTION_WIDTH,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2ad1af',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
