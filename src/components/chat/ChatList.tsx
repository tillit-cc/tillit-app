import React, { useCallback, useRef, useMemo, useState, useImperativeHandle, useEffect } from 'react';
import { View, Text, FlatList, ListRenderItem, StyleSheet, Pressable, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import Reanimated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Message } from '@/db/schema';
import { MessageBubble } from './MessageBubble';
import { SwipeableMessage } from './SwipeableMessage';
import { MessageMetadata, useChatStore } from '@/stores/chat.store';

interface ChatListProps {
  messages: Message[];
  messageMetadata: Map<string, MessageMetadata>;
  currentUserId: number | null;
  highlightedMessageId?: string | null;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onMessageLongPress?: (message: Message, position: { pageY: number }) => void;
  onSwipeReply?: (message: Message) => void;
  onImagePress?: (message: Message) => void;
  onResend?: (message: Message) => void;
  onReplyPress?: (messageId: string) => void;
}

export interface ChatListHandle {
  scrollToBottom: () => void;
  scrollToMessage: (messageId: string) => void;
}

/** Scroll offset threshold (px) to show the FAB button */
const SCROLL_FAB_THRESHOLD = 200;

/**
 * Chat message list using FlatList with inverted mode.
 *
 * Data flow:
 * - messages prop: ASC order (oldest first) from store
 * - Reversed to DESC (newest first) for inverted FlatList
 * - inverted=true renders data[0] at visual bottom → newest at bottom
 * - Visual result: oldest at top, newest at bottom (standard chat layout)
 */
export function ChatList({
  messages,
  messageMetadata,
  currentUserId,
  highlightedMessageId,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  onMessageLongPress,
  onSwipeReply,
  onImagePress,
  onResend,
  onReplyPress,
  ref,
}: ChatListProps & { ref?: React.Ref<ChatListHandle> }) {
    const listRef = useRef<FlatList<Message>>(null);
    const { t } = useTranslation();
    const currentRoomId = useChatStore((s) => s.currentRoomId);
    const room = useChatStore((s) => currentRoomId ? s.rooms.get(currentRoomId) : null);

    const [showScrollButton, setShowScrollButton] = useState(false);
    const isNearBottom = useRef(true);
    const prevNewestId = useRef<string | null>(null);

    // Reverse for inverted list: data[0] = newest = rendered at visual bottom
    const data = useMemo(() => [...messages].reverse(), [messages]);

    // Create a map of messages by ID for quick parent lookup
    const messagesById = useMemo(() => {
      const map = new Map<string, Message>();
      for (const msg of messages) {
        map.set(msg.id, msg);
      }
      return map;
    }, [messages]);

    const handleScrollToBottom = useCallback(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, []);

    const scrollToMessage = useCallback((messageId: string) => {
      const index = data.findIndex((m) => m.id === messageId);
      if (index !== -1) {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      }
    }, [data]);

    useImperativeHandle(ref, () => ({
      scrollToBottom: handleScrollToBottom,
      scrollToMessage,
    }), [handleScrollToBottom, scrollToMessage]);

    // Auto-scroll to bottom when new messages arrive and user is near the bottom.
    // Needed because maintainVisibleContentPosition adjusts the offset UP on new items,
    // hiding new messages below the fold.
    useEffect(() => {
      if (data.length === 0) return;
      const newestId = data[0].id;
      if (prevNewestId.current !== null && prevNewestId.current !== newestId && isNearBottom.current) {
        requestAnimationFrame(() => {
          listRef.current?.scrollToOffset({ offset: 0, animated: true });
        });
      }
      prevNewestId.current = newestId;
    }, [data]);

    // Track scroll position — only update state when crossing threshold
    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y;
      const nearBottom = offset < SCROLL_FAB_THRESHOLD;
      if (isNearBottom.current !== nearBottom) {
        isNearBottom.current = nearBottom;
        setShowScrollButton(!nearBottom);
      }
    }, []);

    const renderItem: ListRenderItem<Message> = useCallback(
      ({ item }) => {
        const metadata = messageMetadata.get(item.id) || {
          showHeader: true,
          showDateSeparator: false,
          username: false as const,
          time: '',
          dateText: '',
        };

        const isOwn = item.idUserFrom === currentUserId;
        const parentMessage = item.idParent ? messagesById.get(item.idParent) : null;

        return (
          <SwipeableMessage onReply={() => onSwipeReply?.(item)}>
            <MessageBubble
              message={item}
              metadata={metadata}
              isOwn={isOwn}
              parentMessage={parentMessage}
              isHighlighted={item.id === highlightedMessageId}
              onLongPress={(msg, pos) => onMessageLongPress?.(msg, pos)}
              onImagePress={onImagePress}
              onResend={onResend}
              onReplyPress={onReplyPress}
            />
          </SwipeableMessage>
        );
      },
      [messageMetadata, currentUserId, messagesById, highlightedMessageId, onMessageLongPress, onSwipeReply, onImagePress, onResend, onReplyPress]
    );

    const keyExtractor = useCallback((item: Message) => item.id, []);

    // In inverted list, "end" is the visual top → triggers loading older messages
    const handleEndReached = useCallback(() => {
      if (hasMore && !isLoadingMore && onLoadMore) {
        onLoadMore();
      }
    }, [hasMore, isLoadingMore, onLoadMore]);

    if (data.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text className="text-gray-500 dark:text-gray-400 text-center">
            {room?.hasSession === false
              ? t('chat.waitingParticipants')
              : t('chat.startConversation')}
          </Text>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          inverted
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.3}
          onScroll={handleScroll}
          onScrollToIndexFailed={(info) => {
            // Retry after layout completes for not-yet-rendered items
            setTimeout(() => {
              listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
            }, 200);
          }}
          scrollEventThrottle={100}
          windowSize={7}
          maxToRenderPerBatch={8}
          ListFooterComponent={
            isLoadingMore ? (
              <View style={styles.loadingContainer}>
                <Text className="text-sm text-gray-500">{t('chat.loading')}</Text>
              </View>
            ) : null
          }
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        />

        {showScrollButton && (
          <Reanimated.View
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(150)}
            style={styles.fabWrapper}
          >
            <Pressable onPress={handleScrollToBottom} style={styles.fab}>
              <Ionicons name="chevron-down" size={20} color="#fff" />
            </Pressable>
          </Reanimated.View>
        )}
      </View>
    );
}

const styles = StyleSheet.create({
  contentContainer: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    flexGrow: 1,
  },
  loadingContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabWrapper: {
    position: 'absolute',
    right: 16,
    bottom: 16,
  },
  fab: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#213649',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
});
