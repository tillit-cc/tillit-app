import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, Alert, ActivityIndicator, Switch } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useShareIntentContext } from 'expo-share-intent';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { RoomListItem } from '@/components/chat/RoomListItem';
import { useChatStore, RoomWithMetadata } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { chatService } from '@/services/chat.service';
import { appInitService } from '@/services/app-init.service';
import { convertFileToImagePayload } from '@/utils/image';
import { formatFileSize, getFileIcon, MAX_FILE_SIZE } from '@/utils/file';
import { MessageStatus, SendResult } from '@/types/message';
import { logger } from '@/utils/logger';

type ShareKind =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; isUrl: boolean }
  | { kind: 'image'; uri: string; mimeType: string; fileName: string; size: number | null }
  | { kind: 'file'; uri: string; mimeType: string; fileName: string; size: number };

export default function ShareTargetScreen() {
  const router = useRouter();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const allRooms = useChatStore((s) => s.allRooms);
  const isBiometricAuthenticated = useAuthStore((s) => s.isBiometricAuthenticated);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [imageMode, setImageMode] = useState<'volatile' | 'persistent'>('persistent');
  const { t } = useTranslation();

  // Classify the incoming share into one of: text/url, image, generic file.
  const share: ShareKind = useMemo(() => {
    const webUrl = shareIntent.webUrl;
    const text = shareIntent.text;
    if (webUrl) {
      return { kind: 'text', text: webUrl, isUrl: true };
    }
    if (text) {
      const trimmed = text.trim();
      const isUrl = /^https?:\/\//i.test(trimmed);
      return { kind: 'text', text: trimmed, isUrl };
    }
    const file = shareIntent.files?.[0];
    if (file) {
      const mime = file.mimeType || 'application/octet-stream';
      const name = file.fileName || 'file';
      const size = typeof file.size === 'number' ? file.size : 0;
      if (mime.startsWith('image/')) {
        return { kind: 'image', uri: file.path, mimeType: mime, fileName: name, size };
      }
      return { kind: 'file', uri: file.path, mimeType: mime, fileName: name, size };
    }
    return { kind: 'empty' };
  }, [shareIntent]);

  const sortedRooms = useMemo(
    () =>
      [...allRooms].sort((a, b) => {
        const rawA = a.lastMessageTime || a.timestampCreate || 0;
        const rawB = b.lastMessageTime || b.timestampCreate || 0;
        const timeA = rawA < 10_000_000_000 ? rawA * 1000 : rawA;
        const timeB = rawB < 10_000_000_000 ? rawB * 1000 : rawB;
        return timeB - timeA;
      }),
    [allRooms],
  );

  // Bootstrap app (idempotent, same as ChatsScreen)
  useEffect(() => {
    if (!isBiometricAuthenticated) return;

    let cancelled = false;
    appInitService
      .initialize()
      .catch((err) => logger.error('[ShareTarget] Bootstrap failed:', err))
      .finally(() => {
        if (!cancelled) setIsInitializing(false);
      });

    return () => { cancelled = true; };
  }, [isBiometricAuthenticated]);

  const handleCancel = useCallback(() => {
    resetShareIntent();
    router.dismissAll();
    router.replace('/(tabs)');
  }, [resetShareIntent, router]);

  const navigateToChat = useCallback((roomId: number) => {
    router.dismissAll();
    router.replace('/(tabs)');
    setTimeout(() => router.navigate(`/chat/${roomId}`), 0);
  }, [router]);

  const handleRoomPress = useCallback(
    async (room: RoomWithMetadata) => {
      if (share.kind === 'empty') return;

      if (share.kind === 'file' && share.size > MAX_FILE_SIZE) {
        Alert.alert(t('common.error'), t('chat.fileTooLarge', { max: formatFileSize(MAX_FILE_SIZE) }));
        return;
      }

      setIsSending(true);
      try {
        let result: SendResult | null = null;

        if (share.kind === 'text') {
          await chatService.sendMessage(room.id, share.text);
        } else if (share.kind === 'image') {
          const payload = await convertFileToImagePayload(share.uri, share.mimeType);
          if (imageMode === 'persistent') {
            result = await chatService.sendPersistentImageMessage(room.id, payload);
          } else {
            result = await chatService.sendImageMessage(room.id, payload);
          }
        } else {
          // Generic file
          result = await chatService.sendFileMessage(
            room.id,
            { uri: share.uri, name: share.fileName, mimeType: share.mimeType, size: share.size },
            { ephemeral: false },
          );
        }

        resetShareIntent();

        if (result?.status === MessageStatus.FAILED) {
          Alert.alert(
            t('share.sendFailed'),
            t('share.sendFailedMsg'),
            [{ text: 'OK', onPress: () => navigateToChat(room.id) }],
          );
        } else if (result?.status === MessageStatus.UNDELIVERED) {
          Alert.alert(
            t('share.undelivered'),
            t('share.undeliveredMsg'),
            [{ text: 'OK', onPress: () => navigateToChat(room.id) }],
          );
        } else {
          navigateToChat(room.id);
        }
      } catch (error) {
        logger.error('[ShareTarget] Send failed:', error);
        Alert.alert(t('common.error'), t('share.sendError'));
        setIsSending(false);
      }
    },
    [share, imageMode, resetShareIntent, navigateToChat, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: RoomWithMetadata }) => (
      <RoomListItem room={item} onPress={handleRoomPress} />
    ),
    [handleRoomPress],
  );

  const keyExtractor = useCallback(
    (item: RoomWithMetadata) => String(item.id),
    [],
  );

  // Show loading while bootstrapping
  if (isInitializing) {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900 items-center justify-center">
        <ActivityIndicator size="large" color="#2ad1af" />
        <Text className="mt-4 text-gray-500 dark:text-gray-400">
          {t('rooms.preparing')}
        </Text>
      </SafeAreaView>
    );
  }

  // Nothing to share
  if (share.kind === 'empty') {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900 items-center justify-center px-8">
        <Ionicons name="alert-circle-outline" size={48} color="#9ca3af" />
        <Text className="mt-4 text-gray-500 dark:text-gray-400 text-center">
          {t('share.noContent')}
        </Text>
        <Pressable onPress={handleCancel} className="mt-6 px-6 py-3 rounded-full" style={{ backgroundColor: '#2ad1af' }}>
          <Text className="text-white font-semibold">{t('common.close')}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900" edges={['top', 'bottom']}>
      {/* Sending overlay */}
      {isSending && (
        <View className="absolute inset-0 z-50 items-center justify-center bg-black/40">
          <View className="bg-white dark:bg-gray-800 rounded-2xl px-8 py-6 items-center">
            <ActivityIndicator size="large" color="#2ad1af" />
            <Text className="mt-3 text-gray-700 dark:text-gray-300 font-medium">
              {t('share.sending')}
            </Text>
          </View>
        </View>
      )}

      {/* Header */}
      <View className="flex-row items-center px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <Pressable onPress={handleCancel} hitSlop={8}>
          <Text className="text-base" style={{ color: '#2ad1af' }}>{t('common.cancel')}</Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-semibold text-gray-900 dark:text-white">
          {t('share.sendTo')}
        </Text>
        <View style={{ width: 56 }} />
      </View>

      {/* Preview row — varies by share kind */}
      {share.kind === 'image' && (
        <View className="flex-row items-center px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <Image
            source={{ uri: share.uri }}
            style={{ width: 56, height: 56, borderRadius: 8 }}
            contentFit="cover"
          />
          <View className="ml-3 flex-1">
            <Text className="text-sm text-gray-900 dark:text-white" numberOfLines={1}>
              {share.fileName || t('share.imageFallback')}
            </Text>
            {share.size ? (
              <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatFileSize(share.size)}
              </Text>
            ) : null}
          </View>
        </View>
      )}

      {share.kind === 'file' && (() => {
        const iconInfo = getFileIcon(share.mimeType, share.fileName);
        return (
          <View className="flex-row items-center px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <View
              style={{
                width: 56, height: 56, borderRadius: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: `${iconInfo.color}22`,
              }}
            >
              <Ionicons name={iconInfo.icon} size={28} color={iconInfo.color} />
            </View>
            <View className="ml-3 flex-1">
              <Text className="text-sm text-gray-900 dark:text-white" numberOfLines={2}>
                {share.fileName}
              </Text>
              <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatFileSize(share.size)}
                {share.mimeType ? ` · ${share.mimeType}` : ''}
              </Text>
            </View>
          </View>
        );
      })()}

      {share.kind === 'text' && (
        <View className="flex-row items-start px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <View
            style={{
              width: 56, height: 56, borderRadius: 8,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(42,209,175,0.15)',
            }}
          >
            <Ionicons
              name={share.isUrl ? 'link-outline' : 'document-text-outline'}
              size={28}
              color="#2ad1af"
            />
          </View>
          <View className="ml-3 flex-1">
            <Text className="text-sm text-gray-900 dark:text-white" numberOfLines={3}>
              {share.text}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {share.isUrl ? t('share.linkLabel') : t('share.textLabel')}
            </Text>
          </View>
        </View>
      )}

      {/* Image mode toggle — only for images */}
      {share.kind === 'image' && (
        <View className="flex-row items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <View className="flex-1 mr-3">
            <Text className="text-sm font-medium text-gray-900 dark:text-white">
              {imageMode === 'persistent' ? t('rooms.saveToServer') : t('rooms.directSend')}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {imageMode === 'persistent'
                ? t('rooms.saveToServerDesc')
                : t('rooms.directSendDesc')}
            </Text>
          </View>
          <Switch
            value={imageMode === 'persistent'}
            onValueChange={(val) => setImageMode(val ? 'persistent' : 'volatile')}
            trackColor={{ false: '#767577', true: '#2ad1af' }}
            thumbColor="#ffffff"
          />
        </View>
      )}

      {/* Room list */}
      <View className="flex-1">
        {sortedRooms.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="chatbubbles-outline" size={40} color="#9ca3af" />
            <Text className="mt-4 text-base text-gray-500 dark:text-gray-400 text-center">
              {t('share.createRoomToShare')}
            </Text>
          </View>
        ) : (
          <FlashList
            data={sortedRooms}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            ItemSeparatorComponent={() => (
              <View className="h-px bg-gray-100 dark:bg-gray-800 ml-20" />
            )}
          />
        )}
      </View>
    </SafeAreaView>
  );
}
