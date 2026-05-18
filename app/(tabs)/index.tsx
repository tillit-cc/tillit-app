import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { RoomListItem } from '@/components/chat/RoomListItem';
import { InvitationModal } from '@/components/modals/InvitationModal';
import { useChatStore, RoomWithMetadata } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { chatService } from '@/services/chat.service';
import { appInitService } from '@/services/app-init.service';
import { logger } from '@/utils/logger';

export default function ChatsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const allRooms = useChatStore((s) => s.allRooms);
  const isBiometricAuthenticated = useAuthStore((s) => s.isBiometricAuthenticated);
  const userId = useAuthStore((s) => s.userId);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showInvitationModal, setShowInvitationModal] = useState(false);
  const listRef = useRef<FlashListRef<RoomWithMetadata>>(null);
  const prevRoomCount = useRef(allRooms.length);

  const sortedRooms = useMemo(
    () =>
      [...allRooms].sort((a, b) => {
        const rawA = a.lastMessageTime || a.timestampCreate || 0;
        const rawB = b.lastMessageTime || b.timestampCreate || 0;
        // Normalize: timestampCreate is in seconds, lastMessageTime in ms
        const timeA = rawA < 10_000_000_000 ? rawA * 1000 : rawA;
        const timeB = rawB < 10_000_000_000 ? rawB * 1000 : rawB;
        return timeB - timeA;
      }),
    [allRooms],
  );

  // Scroll to top when a new room is added
  useEffect(() => {
    if (allRooms.length > prevRoomCount.current && allRooms.length > 0) {
      listRef.current?.scrollToTop({ animated: true });
    }
    prevRoomCount.current = allRooms.length;
  }, [allRooms.length]);

  // Centralized bootstrap - only run when biometric authentication is complete
  // This ensures SignalProtocol.loadStoredLocalUser() has been called before
  // attempting to load sessions or connect to socket
  useEffect(() => {
    if (!isBiometricAuthenticated) {
      logger.info('[ChatsScreen] Waiting for biometric authentication...');
      return;
    }

    appInitService.initialize().catch((err) =>
      logger.error('[ChatsScreen] Bootstrap failed:', err)
    );
  }, [isBiometricAuthenticated]);

  const handleRoomPress = useCallback(
    (room: RoomWithMetadata) => {
      // Clear any pending notification navigation — the user's explicit tap
      // takes priority over the automatic redirect from the layout effect.
      useAppStore.getState().setPendingNotificationRoomId(null);
      router.push(`/chat/${room.id}`);
    },
    [router]
  );

  const handleRoomDelete = useCallback((room: RoomWithMetadata) => {
    const isAdmin = room.idUser === userId;
    const isLeave = room.administered === 1 && !isAdmin;

    const title = isLeave ? t('rooms.leaveRoom') : t('rooms.deleteRoom');
    const message = isLeave ? t('rooms.leaveRoomMsg') : t('rooms.deleteRoomMsg');
    const btnText = isLeave ? t('rooms.leaveBtn') : t('common.delete');

    Alert.alert(
      title,
      message,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: btnText,
          style: 'destructive',
          onPress: async () => {
            try {
              await chatService.deleteRoom(room.id);
            } catch (error: any) {
              Alert.alert(t('common.error'), error?.message || t('rooms.deleteRoomError'));
            }
          },
        },
      ]
    );
  }, [userId]);

  const handleNewRoom = useCallback(() => {
    setShowInvitationModal(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await chatService.loadRooms();
    } catch (error) {
      logger.error('[ChatsScreen] Refresh failed:', error);
    }
    setIsRefreshing(false);
  }, []);

  const handleRoomCreated = useCallback(
    (roomId: number, inviteCode: string) => {
      // Room is already added to store by chatService.createRoom
      // Copy invite code to clipboard
      Clipboard.setStringAsync(inviteCode).catch(() => {});
    },
    []
  );

  const handleRoomJoined = useCallback(() => {
    setShowInvitationModal(false);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: RoomWithMetadata }) => (
      <RoomListItem
        room={item}
        onPress={handleRoomPress}
        onDelete={handleRoomDelete}
      />
    ),
    [handleRoomPress, handleRoomDelete]
  );

  const keyExtractor = useCallback((item: RoomWithMetadata) => String(item.id), []);

  const EmptyState = () => (
    <View className="flex-1 items-center justify-center px-8 py-20">
      <View className="w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800 items-center justify-center mb-4">
        <Ionicons name="chatbubbles-outline" size={40} color="#9ca3af" />
      </View>
      <Text className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-2">
        {t('rooms.noConversations')}
      </Text>
      <Text className="text-base text-gray-500 dark:text-gray-400 text-center mb-6">
        {t('rooms.startNew')}
      </Text>
      <Pressable
        onPress={handleNewRoom}
        className="flex-row items-center px-6 py-3 rounded-full"
        style={{ backgroundColor: '#2ad1af' }}
      >
        <Ionicons name="chatbubble" size={20} color="#fff" />
        <Text className="ml-2 text-white font-semibold">{t('rooms.newChat')}</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900" edges={['bottom']}>
      <View className="flex-1">
        <FlashList
          ref={listRef}
          data={sortedRooms}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          ItemSeparatorComponent={() => (
            <View className="h-px bg-gray-100 dark:bg-gray-800 ml-20" />
          )}
          ListEmptyComponent={EmptyState}
          contentContainerStyle={{ flexGrow: 1 }}
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
        />
      </View>

      {/* FAB for new room */}
      {allRooms.length > 0 && (
        <Pressable
          onPress={handleNewRoom}
          className="absolute bottom-6 right-6 w-14 h-14 rounded-full items-center justify-center shadow-lg"
          style={{ backgroundColor: '#2ad1af' }}
        >
          <Ionicons name="chatbubble" size={24} color="#fff" />
        </Pressable>
      )}

      {/* Invitation Modal */}
      <InvitationModal
        visible={showInvitationModal}
        onClose={() => setShowInvitationModal(false)}
        onRoomCreated={handleRoomCreated}
        onRoomJoined={handleRoomJoined}
      />
    </SafeAreaView>
  );
}
