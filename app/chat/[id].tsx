import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Text, useColorScheme, Alert } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { ChatList, ChatListHandle } from '@/components/chat/ChatList';
import { MessageBar } from '@/components/chat/MessageBar';
import { RoomDetailsModal } from '@/components/modals/RoomDetailsModal';
import { AttachmentModal } from '@/components/modals/AttachmentModal';
import { ImageViewerModal } from '@/components/modals/ImageViewerModal';
import { ImagePreviewModal, ImageMode } from '@/components/modals/ImagePreviewModal';
import { DocumentPreviewModal, DocumentMode } from '@/components/modals/DocumentPreviewModal';
import { EphemeralImageViewerModal } from '@/components/modals/EphemeralImageViewerModal';
import { EPHEMERAL_DEFAULT_DURATION, EPHEMERAL_DEFAULT_TTL_HOURS } from '@/config/app.config';
import { MessageContextMenu } from '@/components/chat/MessageContextMenu';
import { useChatStore, buildMessageMetadata } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { Message, Profile } from '@/db/schema';
import { chatService } from '@/services/chat.service';
import { UserMessageType } from '@/types/message';
import { sessionService } from '@/services/session.service';
import { useServerStore } from '@/stores/server.store';
import { serverRegistry } from '@/services/server-registry';
import { toBackendRoomId, getServerIdFromRoomId } from '@/utils/server-id';
import { roomRepository } from '@/db/repositories/room.repository';
import { profileRepository } from '@/db/repositories/profile.repository';
import { useImagePicker, PickedImage } from '@/hooks/useImagePicker';
import { useDocumentPicker, PickedDocument } from '@/hooks/useDocumentPicker';
import { logger } from '@/utils/logger';
import { extractFirstLink, hasLink as bodyHasLink } from '@/utils/links';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const paramRoomId = parseInt(id || '0', 10);
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const { t } = useTranslation();
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomPadding = insets.bottom;
  const messageBarWrapperStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(keyboardProgress.value, [0, 1], [bottomPadding, 0]),
  }));

  const setCurrentRoom = useChatStore((s) => s.setCurrentRoom);
  const setPaginationState = useChatStore((s) => s.setPaginationState);
  const paginationState = useChatStore((s) => s.paginationState);

  // Subscribe to reactive state with selectors
  const messagesMap = useChatStore((s) => s.messages);
  const roomsMap = useChatStore((s) => s.rooms);
  const profilesMap = useChatStore((s) => s.profiles);
  const { userId } = useAuthStore();

  // Resolve: notification may navigate with a backend room ID
  const roomId = useMemo(() => {
    if (roomsMap.has(paramRoomId)) return paramRoomId;
    for (const [localId] of roomsMap) {
      if (toBackendRoomId(localId) === paramRoomId) return localId;
    }
    return paramRoomId; // store not yet loaded — will re-resolve on next render
  }, [roomsMap, paramRoomId]);

  const [imageMode, setImageMode] = useState<ImageMode>('persistent');
  const [ephemeralDuration, setEphemeralDuration] = useState(EPHEMERAL_DEFAULT_DURATION);
  const [ephemeralTtlHours, setEphemeralTtlHours] = useState(EPHEMERAL_DEFAULT_TTL_HOURS);
  const [replyMessage, setReplyMessage] = useState<Message | null>(null);
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [ephemeralViewerMessage, setEphemeralViewerMessage] = useState<Message | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    message: Message;
    pressY: number;
  } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<PickedImage | null>(null);
  const [pendingDocument, setPendingDocument] = useState<PickedDocument | null>(null);
  const [documentMode, setDocumentMode] = useState<DocumentMode>('persistent');

  const router = useRouter();
  const hasInitialized = useRef(false);
  const chatListRef = useRef<ChatListHandle>(null);
  const { pickFromCamera, pickFromGallery, isLoading: isPickingImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  // Typing indicator state
  const typingUsers = useChatStore((s) => s.typingUsers);
  const isTyping = useMemo(() => {
    const roomTyping = typingUsers.get(roomId);
    if (!roomTyping || roomTyping.size === 0) return false;
    for (const uid of roomTyping.keys()) {
      if (uid !== userId) return true;
    }
    return false;
  }, [typingUsers, roomId, userId]);

  const room = useMemo(() => roomsMap.get(roomId) || null, [roomsMap, roomId]);
  const messages = useMemo(() => messagesMap.get(roomId) || [], [messagesMap, roomId]);
  const profiles = useMemo(
    () => profilesMap.get(roomId) || new Map<number, Profile>(),
    [profilesMap, roomId]
  );
  const messageMetadata = useMemo(
    () => buildMessageMetadata(messages, profiles, userId ?? null),
    [messages, profiles, userId]
  );
  const pagination = useMemo(
    () => paginationState.get(roomId) || { hasMore: false, oldestTimestamp: null, isLoadingMore: false },
    [paginationState, roomId]
  );

  // Set current room and load data (server auto-joins rooms)
  useEffect(() => {
    setCurrentRoom(roomId);

    // Immediately reset unread badge (instant UI update before async markRoomAsRead completes)
    useChatStore.getState().updateRoomInList(roomId, { unreadCount: 0 });

    // Load messages and profiles from DB
    chatService.loadRoomMessages(roomId);
    chatService.loadRoomProfiles(roomId);

    // Resume sessions for this room
    sessionService.loadSessions(roomId);

    // Mark messages as read when entering room
    chatService.markRoomAsRead(roomId);

    hasInitialized.current = true;

    return () => {
      setCurrentRoom(null);
    };
  }, [roomId, setCurrentRoom]);

  // Auto-navigate back when room is deleted (e.g. remote room_deleted event)
  useEffect(() => {
    if (hasInitialized.current && room === null) {
      router.back();
    }
  }, [room, router]);

  // Block access / force exit if the server for this room is banned
  const bannedServers = useServerStore((s) => s.bannedServers);
  const serverBanned = bannedServers.has(getServerIdFromRoomId(roomId));
  useEffect(() => {
    if (serverBanned) {
      Alert.alert(t('report.serverBanned'), t('auth.accountBanned'), [
        { text: t('common.ok'), onPress: () => router.back() },
      ]);
    }
  }, [serverBanned, router, t]);

  // Handle sending messages via ChatService (with encryption)
  const handleSend = useCallback(
    (text: string, parentId?: string) => {
      if (!userId) return;

      // Scroll immediately — don't wait for encryption/send to finish
      chatListRef.current?.scrollToBottom();
      setReplyMessage(null);

      chatService.sendMessage(roomId, text, parentId).catch((error) => {
        logger.error('[ChatScreen] Send failed:', error);
      });
    },
    [roomId, userId]
  );

  const handleLoadMore = useCallback(async () => {
    if (pagination.isLoadingMore || !pagination.hasMore || !pagination.oldestTimestamp) return;

    setPaginationState(roomId, { isLoadingMore: true });

    try {
      await chatService.loadMoreMessages(roomId, pagination.oldestTimestamp);
    } catch (error) {
      logger.error('[ChatScreen] Load more messages failed:', error);
      setPaginationState(roomId, { isLoadingMore: false });
    }
  }, [roomId, pagination, setPaginationState]);

  const handleMessageLongPress = useCallback((message: Message, position: { pageY: number }) => {
    setContextMenu({ message, pressY: position.pageY });
    setHighlightedMessageId(message.id);
  }, []);

  const handleContextReply = useCallback(() => {
    if (contextMenu) setReplyMessage(contextMenu.message);
    setContextMenu(null);
    setHighlightedMessageId(null);
  }, [contextMenu]);

  const handleContextCopyText = useCallback(async () => {
    if (!contextMenu) return;
    const body = contextMenu.message.body;
    setContextMenu(null);
    setHighlightedMessageId(null);
    try {
      await Clipboard.setStringAsync(body);
      Alert.alert(t('common.copied'));
    } catch (e) {
      logger.warn('[ChatScreen] copy text failed', e);
    }
  }, [contextMenu, t]);

  const handleContextCopyLink = useCallback(async () => {
    if (!contextMenu) return;
    const url = extractFirstLink(contextMenu.message.body);
    setContextMenu(null);
    setHighlightedMessageId(null);
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      Alert.alert(t('common.copied'), t('common.linkCopied'));
    } catch (e) {
      logger.warn('[ChatScreen] copy link failed', e);
    }
  }, [contextMenu, t]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    const messageToDelete = contextMenu.message;
    setContextMenu(null);
    // Keep highlight visible through the Alert — clear on dismiss
    Alert.alert(t('chat.deleteMessageTitle'), t('chat.deleteMessageMsg'), [
      { text: t('common.cancel'), style: 'cancel', onPress: () => setHighlightedMessageId(null) },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setHighlightedMessageId(null);
          try {
            await chatService.deleteMessageForEveryone(roomId, messageToDelete.id);
          } catch {
            Alert.alert(t('common.error'), t('chat.deleteMessageError'));
          }
        },
      },
    ]);
  }, [contextMenu, roomId]);

  const handleContextReport = useCallback(() => {
    if (!contextMenu) return;
    const messageToReport = contextMenu.message;
    setContextMenu(null);
    setHighlightedMessageId(null);

    const reasons: Array<{ key: 'spam' | 'harassment' | 'illegal_content' | 'other'; label: string }> = [
      { key: 'spam', label: t('report.reasonSpam') },
      { key: 'harassment', label: t('report.reasonHarassment') },
      { key: 'illegal_content', label: t('report.reasonIllegal') },
      { key: 'other', label: t('report.reasonOther') },
    ];

    Alert.alert(
      t('report.messageTitle'),
      t('report.selectReason'),
      [
        ...reasons.map((r) => ({
          text: r.label,
          onPress: async () => {
            try {
              const api = serverRegistry.getApiForRoom(roomId);
              await api.report({
                reportedUserId: messageToReport.idUserFrom,
                roomId: toBackendRoomId(roomId),
                messageId: messageToReport.id,
                reason: r.key,
              });
              Alert.alert(t('report.sent'), t('report.sentMessage'));
            } catch {
              Alert.alert(t('common.error'), t('report.error'));
            }
          },
        })),
        { text: t('common.cancel'), style: 'cancel' },
      ]
    );
  }, [contextMenu, roomId]);

  const handleSwipeReply = useCallback((message: Message) => {
    setReplyMessage(message);
  }, []);

  const handleReplyPress = useCallback((messageId: string) => {
    chatListRef.current?.scrollToMessage(messageId);
    setHighlightedMessageId(messageId);
    // Clear highlight after a brief moment
    setTimeout(() => setHighlightedMessageId(null), 2000);
  }, []);

  const handleImagePress = useCallback((message: Message) => {
    if (message.type === UserMessageType.EPHEMERAL_IMAGE) {
      try {
        const parsed = JSON.parse(message.body);
        // Sender has no mediaId — cannot reopen
        if (!parsed.mediaId) return;
        const isExpired = parsed.expired === true
          || (message.expiryDatetime !== null && Date.now() >= message.expiryDatetime);
        if (isExpired) return;
      } catch { return; }
      setEphemeralViewerMessage(message);
    } else {
      setViewerImage(message.body);
    }
  }, []);

  const handleResend = useCallback((message: Message) => {
    const isImage = message.type === UserMessageType.IMAGE
      || message.type === UserMessageType.PERSISTENT_IMAGE;
    const isFile = message.type === UserMessageType.FILE;

    if (isImage) {
      Alert.alert(
        t('chat.resendImageTitle'),
        t('chat.resendImageMsg'),
        [
          {
            text: t('chat.volatileOption'),
            onPress: () => chatService.resendMessage(roomId, message.id, 'volatile')
              .catch(() => Alert.alert(t('common.error'), t('chat.resendImageError'))),
          },
          {
            text: t('chat.persistentOption'),
            onPress: () => chatService.resendMessage(roomId, message.id, 'persistent')
              .catch(() => Alert.alert(t('common.error'), t('chat.resendImageError'))),
          },
          { text: t('common.cancel'), style: 'cancel' },
        ]
      );
    } else if (isFile) {
      Alert.alert(
        t('chat.resendFileTitle'),
        t('chat.resendFileMsg'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('chat.resendBtn'),
            onPress: () => chatService.resendFileMessage(roomId, message.id)
              .catch(() => Alert.alert(t('common.error'), t('chat.resendFileError'))),
          },
        ]
      );
    } else {
      Alert.alert(
        t('chat.resendMessageTitle'),
        t('chat.resendMessageMsg'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('chat.resendBtn'),
            onPress: () => chatService.resendTextMessage(roomId, message.id)
              .catch(() => Alert.alert(t('common.error'), t('chat.resendMessageError'))),
          },
        ]
      );
    }
  }, [roomId]);

  const handleCloseReply = useCallback(() => {
    setReplyMessage(null);
  }, []);

  const handleAttach = useCallback(() => {
    setShowAttachmentModal(true);
  }, []);

  const handleImageSelected = useCallback(
    async (image: PickedImage) => {
      if (!userId) return;

      const payload = {
        base64: image.base64,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        size: image.size,
      };

      try {
        if (imageMode === 'ephemeral') {
          await chatService.sendEphemeralImageMessage(roomId, payload, ephemeralDuration, ephemeralTtlHours, replyMessage?.id);
        } else if (imageMode === 'persistent') {
          await chatService.sendPersistentImageMessage(roomId, payload, replyMessage?.id);
        } else {
          await chatService.sendImageMessage(roomId, payload, replyMessage?.id);
        }
        setReplyMessage(null);
      } catch (error) {
        logger.error('[ChatScreen] Send image failed:', error);
        Alert.alert(t('common.error'), t('chat.sendImageError'));
      }
    },
    [roomId, userId, replyMessage, imageMode, ephemeralDuration, ephemeralTtlHours]
  );

  const handleCameraPress = useCallback(async () => {
    const image = await pickFromCamera();
    if (image) setPendingImage(image);
  }, [pickFromCamera]);

  const handleGalleryPress = useCallback(async () => {
    const image = await pickFromGallery();
    if (image) setPendingImage(image);
  }, [pickFromGallery]);

  const handleImageConfirm = useCallback(() => {
    if (pendingImage) {
      const image = pendingImage;
      setPendingImage(null);
      handleImageSelected(image);
    }
  }, [pendingImage, handleImageSelected]);

  const handleImageCancel = useCallback(() => {
    setPendingImage(null);
  }, []);

  const handleDocumentPress = useCallback(async () => {
    const doc = await pickDocument();
    if (doc) setPendingDocument(doc);
  }, [pickDocument]);

  const handleDocumentConfirm = useCallback(async () => {
    if (!pendingDocument || !userId) return;
    const doc = pendingDocument;
    const mode = documentMode;
    setPendingDocument(null);
    try {
      await chatService.sendFileMessage(roomId, doc, {
        ephemeral: mode === 'ephemeral',
        ttlHours: ephemeralTtlHours,
        parentId: replyMessage?.id,
      });
      setReplyMessage(null);
    } catch (error) {
      logger.error('[ChatScreen] Send document failed:', error);
      Alert.alert(t('common.error'), t('chat.sendFileError'));
    }
  }, [pendingDocument, userId, documentMode, ephemeralTtlHours, replyMessage, roomId, t]);

  const handleDocumentCancel = useCallback(() => {
    setPendingDocument(null);
  }, []);

  const handleUpdateRoomName = useCallback(async (newName: string) => {
    const api = serverRegistry.getApiForRoom(roomId);
    const backendId = toBackendRoomId(roomId);
    await api.updateRoom(backendId, { name: newName });
    await roomRepository.update(roomId, { name: newName });
    useChatStore.getState().updateRoomInList(roomId, { name: newName });
  }, [roomId]);

  const handleUpdateUsername = useCallback(async (newUsername: string) => {
    if (!userId) return;
    const api = serverRegistry.getApiForRoom(roomId);
    const backendId = toBackendRoomId(roomId);
    await api.updateProfile(backendId, { username: newUsername });
    // Update local database
    await profileRepository.upsert({
      idUser: userId,
      idRoom: roomId,
      username: newUsername,
    });
    // Update local store
    useChatStore.getState().updateProfile(roomId, userId, { username: newUsername });
  }, [roomId, userId]);

  const fetchMembers = useCallback(async () => {
    const api = serverRegistry.getApiForRoom(roomId);
    const backendId = toBackendRoomId(roomId);
    return api.getRoomMembers(backendId);
  }, [roomId]);

  const handleReportUser = useCallback((reportedUserId: number, username: string) => {
    const reasons: Array<{ key: 'spam' | 'harassment' | 'illegal_content' | 'other'; label: string }> = [
      { key: 'spam', label: t('report.reasonSpam') },
      { key: 'harassment', label: t('report.reasonHarassment') },
      { key: 'illegal_content', label: t('report.reasonIllegal') },
      { key: 'other', label: t('report.reasonOther') },
    ];

    Alert.alert(
      t('report.userTitle'),
      `${t('report.selectReason')} — ${username}`,
      [
        ...reasons.map((r) => ({
          text: r.label,
          onPress: async () => {
            try {
              const api = serverRegistry.getApiForRoom(roomId);
              await api.report({
                reportedUserId,
                roomId: toBackendRoomId(roomId),
                messageId: null,
                reason: r.key,
              });
              Alert.alert(t('report.sent'), t('report.sentMessage'));
            } catch {
              Alert.alert(t('common.error'), t('report.error'));
            }
          },
        })),
        { text: t('common.cancel'), style: 'cancel' },
      ]
    );
  }, [roomId]);

  const handleDeleteRoom = useCallback(() => {
    const isAdmin = room?.idUser === userId;
    const isLeave = room?.administered === 1 && !isAdmin;

    const title = isLeave ? t('rooms.leaveRoom') : t('rooms.deleteRoom');
    const message = isLeave ? t('rooms.leaveRoomMsg') : t('rooms.deleteRoomMsg');
    const btnText = isLeave ? t('rooms.leaveBtn') : t('common.delete');

    Alert.alert(title, message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: btnText,
        style: 'destructive',
        onPress: async () => {
          setShowRoomDetails(false);
          try {
            await chatService.deleteRoom(roomId);
            router.back();
          } catch (error: any) {
            Alert.alert(t('common.error'), error?.message || t('rooms.deleteRoomError'));
          }
        },
      },
    ]);
  }, [roomId, room, userId, router]);

  // Get current user's username from profiles
  const myUsername = useMemo(() => {
    if (!userId) return '';
    return profiles.get(userId)?.username || '';
  }, [profiles, userId]);

  // For 2-person rooms, show the other participant's name
  const displayName = useMemo(() => {
    if (!profiles || profiles.size !== 2 || !userId) return null;
    for (const [uid, profile] of profiles) {
      if (uid !== userId && profile.username) {
        return profile.username;
      }
    }
    return null;
  }, [profiles, userId]);

  const servers = useServerStore((s) => s.servers);
  const headerServerName = servers.length > 1
    ? servers.find((s) => s.id === getServerIdFromRoomId(roomId))?.name
    : undefined;

  const HeaderTitle = useCallback(() => (
    <Pressable
      onPress={() => setShowRoomDetails(true)}
      className="flex-row items-center"
    >
      <Text className="text-base font-semibold text-gray-900 dark:text-white" numberOfLines={1}>
        {displayName || room?.name || t('chat.roomFallback', { id: roomId })}
      </Text>
      {headerServerName && (
        <View className="ml-1.5 rounded px-1 py-0.5 bg-gray-200 dark:bg-gray-700">
          <Text className="text-[10px] text-gray-500 dark:text-gray-400">{headerServerName}</Text>
        </View>
      )}
      <Ionicons name="chevron-forward" size={16} color="#9ca3af" style={{ marginLeft: 4 }} />
    </Pressable>
  ), [displayName, room?.name, roomId, headerServerName]);

  const isDisabled = room?.hasSession === false;

  // Server banned — render nothing while Alert + router.back() fire
  if (serverBanned) {
    return <Stack.Screen options={{ headerTitle: '', headerBackButtonDisplayMode: 'minimal' }} />;
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: HeaderTitle,
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
        style={{
          flex: 1,
          backgroundColor: colorScheme === 'dark' ? '#030712' : '#f9fafb',
        }}
      >
        <View className="flex-1">
          <ChatList
            ref={chatListRef}
            messages={messages}
            messageMetadata={messageMetadata}
            currentUserId={userId}
            highlightedMessageId={highlightedMessageId}
            onLoadMore={handleLoadMore}
            isLoadingMore={pagination.isLoadingMore}
            hasMore={pagination.hasMore}
            onMessageLongPress={handleMessageLongPress}
            onSwipeReply={handleSwipeReply}
            onImagePress={handleImagePress}
            onResend={handleResend}
            onReplyPress={handleReplyPress}
          />
        </View>

        <Animated.View
          style={[
            messageBarWrapperStyle,
          ]}
        >
          <MessageBar
            onSend={handleSend}
            onAttach={handleAttach}
            replyMessage={replyMessage}
            onCloseReply={handleCloseReply}
            disabled={isDisabled}
            isTyping={isTyping}
            roomId={roomId}
          />
        </Animated.View>
      </KeyboardAvoidingView>

      <RoomDetailsModal
        visible={showRoomDetails}
        roomId={roomId}
        currentName={room?.name || ''}
        currentUsername={myUsername}
        currentUserId={userId}
        inviteCode={room?.inviteCode || ''}
        administered={room?.administered}
        roomOwnerId={room?.idUser}
        onClose={() => setShowRoomDetails(false)}
        onUpdateName={handleUpdateRoomName}
        onUpdateUsername={handleUpdateUsername}
        onDeleteRoom={handleDeleteRoom}
        onReportUser={handleReportUser}
        fetchMembers={fetchMembers}
      />

      <AttachmentModal
        visible={showAttachmentModal}
        onClose={() => setShowAttachmentModal(false)}
        onCameraPress={handleCameraPress}
        onGalleryPress={handleGalleryPress}
        onDocumentPress={handleDocumentPress}
        imageMode={imageMode}
        onImageModeChange={setImageMode}
      />

      <DocumentPreviewModal
        visible={pendingDocument !== null}
        document={pendingDocument}
        mode={documentMode}
        onModeChange={setDocumentMode}
        ephemeralTtlHours={ephemeralTtlHours}
        onEphemeralTtlHoursChange={setEphemeralTtlHours}
        onSend={handleDocumentConfirm}
        onCancel={handleDocumentCancel}
      />

      <ImageViewerModal
        visible={viewerImage !== null}
        imageData={viewerImage}
        onClose={() => setViewerImage(null)}
      />

      <ImagePreviewModal
        visible={pendingImage !== null}
        image={pendingImage}
        imageMode={imageMode}
        onImageModeChange={setImageMode}
        ephemeralDuration={ephemeralDuration}
        onEphemeralDurationChange={setEphemeralDuration}
        ephemeralTtlHours={ephemeralTtlHours}
        onEphemeralTtlHoursChange={setEphemeralTtlHours}
        onSend={handleImageConfirm}
        onCancel={handleImageCancel}
      />

      <EphemeralImageViewerModal
        visible={ephemeralViewerMessage !== null}
        message={ephemeralViewerMessage}
        roomId={roomId}
        onClose={() => setEphemeralViewerMessage(null)}
      />

      <MessageContextMenu
        visible={contextMenu !== null}
        message={contextMenu?.message ?? null}
        pressY={contextMenu?.pressY ?? 0}
        isOwn={
          contextMenu?.message
            ? contextMenu.message.idUserFrom === userId ||
              contextMenu.message.idUserFrom === serverRegistry.getUserIdForRoom(roomId)
            : false
        }
        hasLink={
          contextMenu?.message?.type === UserMessageType.TEXT &&
          bodyHasLink(contextMenu.message.body)
        }
        onReply={handleContextReply}
        onCopyText={handleContextCopyText}
        onCopyLink={handleContextCopyLink}
        onDelete={handleContextDelete}
        onReport={handleContextReport}
        onClose={() => { setContextMenu(null); setHighlightedMessageId(null); }}
      />
    </>
  );
}
