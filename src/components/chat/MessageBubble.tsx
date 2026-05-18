import React, { memo, useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator, GestureResponderEvent, useColorScheme } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import i18next from 'i18next';
import * as Sharing from 'expo-sharing';
import { Message } from '@/db/schema';
import { MessageStatus, UserMessageType, FileMessagePayload } from '@/types/message';
import { MessageMetadata } from '@/stores/chat.store';
import { resolveImagePath } from '@/utils/image';
import { splitTextWithLinks, openLink } from '@/utils/links';
import { getFileIcon, formatFileSize, fileExists, resolveFilePath } from '@/utils/file';
import { chatService } from '@/services/chat.service';
import { logger } from '@/utils/logger';
import { getMessagePreview } from '@/utils/message-preview';

const MAX_IMAGE_WIDTH = 220;
const MAX_IMAGE_HEIGHT = 280;
const TEXT_COLLAPSE_LINES = 12;

interface MessageBubbleProps {
  message: Message;
  metadata: MessageMetadata;
  isOwn: boolean;
  parentMessage?: Message | null;
  isHighlighted?: boolean;
  onLongPress?: (message: Message, position: { pageY: number }) => void;
  onImagePress?: (message: Message) => void;
  onResend?: (message: Message) => void;
  onReplyPress?: (messageId: string) => void;
}

/**
 * Generate a consistent color based on user ID
 */
function getUserColor(userId: number): string {
  if (!userId) return '#6b7280';
  const hue = (userId * 137.508) % 360;
  return `hsl(${hue}, 50%, 40%)`;
}

/**
 * Status icon for message delivery state
 */
function StatusIcon({ status }: { status: number }) {
  switch (status) {
    case MessageStatus.PENDING:
    case MessageStatus.SENDING:
      return <Ionicons name="time-outline" size={14} color="rgba(255,255,255,0.7)" />;
    case MessageStatus.SENT:
      return <Ionicons name="checkmark" size={14} color="rgba(255,255,255,0.7)" />;
    case MessageStatus.DELIVERED:
      return <Ionicons name="checkmark-done" size={14} color="rgba(255,255,255,0.7)" />;
    case MessageStatus.READ:
      // White color to contrast with teal background (#2ad1af)
      return <Ionicons name="checkmark-done" size={14} color="#ffffff" />;
    case MessageStatus.FAILED:
      return <Ionicons name="alert-circle" size={14} color="#ef4444" />;
    case MessageStatus.UNDELIVERED:
      return <Ionicons name="alert-circle-outline" size={14} color="#f59e0b" />;
    default:
      return null;
  }
}

/**
 * Text message content — collapses long messages with a "Read more" toggle
 */
function TextContent({ body, isOwn }: { body: string; isOwn: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [measured, setMeasured] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const segments = useMemo(() => splitTextWithLinks(body), [body]);

  // Check if message is a single emoji
  const isEmoji = /^[\p{Extended_Pictographic}]+$/u.test(body.trim());

  if (isEmoji && body.length <= 8) {
    return <Text className="text-4xl">{body}</Text>;
  }

  const textColor = isOwn ? 'text-[#213649]' : 'text-white';
  const linkColor = isOwn ? '#0d3a30' : '#7dd3fc';

  return (
    <View>
      <Text
        className={`text-base ${textColor}`}
        numberOfLines={!measured ? undefined : (expanded ? undefined : TEXT_COLLAPSE_LINES)}
        onTextLayout={(e) => {
          if (!measured) {
            setMeasured(true);
            if (e.nativeEvent.lines.length > TEXT_COLLAPSE_LINES) {
              setIsTruncated(true);
            }
          }
        }}
      >
        {segments.map((seg, i) =>
          seg.type === 'text' ? (
            <Text key={i}>{seg.value}</Text>
          ) : (
            <Text
              key={i}
              onPress={() => openLink(seg.url)}
              suppressHighlighting
              style={{ color: linkColor, textDecorationLine: 'underline' }}
            >
              {seg.raw}
            </Text>
          ),
        )}
      </Text>
      {isTruncated && (
        <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={4}>
          <Text
            className="text-xs font-semibold mt-1"
            style={{ color: isOwn ? 'rgba(33,54,73,0.6)' : 'rgba(255,255,255,0.6)' }}
          >
            {expanded ? i18next.t('chat.showLess') : i18next.t('chat.readMore')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Parse image body JSON into structured data.
 * Body format: {filePath, thumbnail, width, height, mimeType}
 * During optimistic send: {base64, thumbnail, width, height, mimeType}
 */
function parseImageBody(body: string) {
  let parsed: any = {};
  try {
    parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') parsed = {};
  } catch {
    parsed = {};
  }
  return {
    base64: (parsed.base64 as string) || '',
    thumbnail: (parsed.thumbnail as string) || '',
    filePath: (parsed.filePath as string) || '',
    mediaId: (parsed.mediaId as string) || '',
    width: (parsed.width as number) || 0,
    height: (parsed.height as number) || 0,
    mimeType: (parsed.mimeType as string) || 'image/jpeg',
  };
}

/**
 * Build a displayable image URI for list view.
 * Priority: thumbnail > filePath > base64 (optimistic send only)
 */
function buildListImageUri(data: ReturnType<typeof parseImageBody>): string {
  if (data.thumbnail) {
    return `data:image/jpeg;base64,${data.thumbnail}`;
  }
  if (data.filePath) {
    try { return resolveImagePath(data.filePath); } catch { return ''; }
  }
  // base64 present only during optimistic send (before persistImageToFilesystem)
  if (data.base64) {
    return `data:${data.mimeType};base64,${data.base64}`;
  }
  return '';
}

/**
 * Build a full-resolution image URI for the viewer.
 * Priority: filePath > base64 (optimistic send only)
 */
export function buildFullImageUri(body: string): string {
  const data = parseImageBody(body);
  if (data.filePath) {
    try { return resolveImagePath(data.filePath); } catch { return ''; }
  }
  // base64 present only during optimistic send (before persistImageToFilesystem)
  if (data.base64) {
    return `data:${data.mimeType};base64,${data.base64}`;
  }
  return '';
}

/**
 * Image message content with dynamic sizing.
 * Renders thumbnail in list for performance; full image loads in viewer.
 */
function ImageContent({
  body,
  onPress,
  onLongPress,
  isPersistent,
}: {
  body: string;
  onPress?: () => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  isPersistent?: boolean;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const imageData = useMemo(() => parseImageBody(body), [body]);

  // Calculate display dimensions maintaining aspect ratio
  const displayDimensions = useMemo(() => {
    const { width, height } = imageData;

    if (!width || !height) {
      return { width: MAX_IMAGE_WIDTH, height: MAX_IMAGE_WIDTH };
    }

    const aspectRatio = width / height;

    let displayWidth = width;
    let displayHeight = height;

    if (displayWidth > MAX_IMAGE_WIDTH) {
      displayWidth = MAX_IMAGE_WIDTH;
      displayHeight = displayWidth / aspectRatio;
    }

    if (displayHeight > MAX_IMAGE_HEIGHT) {
      displayHeight = MAX_IMAGE_HEIGHT;
      displayWidth = displayHeight * aspectRatio;
    }

    displayWidth = Math.max(displayWidth, 100);
    displayHeight = Math.max(displayHeight, 100);

    return { width: Math.round(displayWidth), height: Math.round(displayHeight) };
  }, [imageData]);

  const imageUri = useMemo(() => buildListImageUri(imageData), [imageData]);
  const isDownloading = !!imageData.mediaId && !imageData.filePath && !imageData.base64;

  if (hasError || !imageUri) {
    return (
      <View
        className="rounded-lg overflow-hidden bg-gray-700 items-center justify-center"
        style={{ width: displayDimensions.width, height: displayDimensions.height }}
      >
        <Ionicons name="image-outline" size={32} color="#9ca3af" />
        <Text className="text-xs text-gray-400 mt-1">{i18next.t('chat.imageNotAvailable')}</Text>
      </View>
    );
  }

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} className="rounded-lg overflow-hidden">
      {isLoading && (
        <View
          className="absolute inset-0 bg-gray-700 items-center justify-center z-10"
          style={{ width: displayDimensions.width, height: displayDimensions.height }}
        >
          <ActivityIndicator size="small" color="#2ad1af" />
        </View>
      )}
      {isDownloading && (
        <View
          className="absolute inset-0 items-center justify-center z-20"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
        >
          <ActivityIndicator size="small" color="#ffffff" />
        </View>
      )}
      <Image
        source={{ uri: imageUri }}
        style={{ width: displayDimensions.width, height: displayDimensions.height }}
        contentFit="cover"
        transition={200}
        recyclingKey={imageUri}
        onLoadStart={() => setIsLoading(true)}
        onLoadEnd={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          setHasError(true);
        }}
      />
      {/* Volatile / persistent badge */}
      <View
        className="absolute bottom-1.5 left-1.5 rounded-full items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.45)', width: 22, height: 22 }}
      >
        <Ionicons
          name={isPersistent ? 'cloud-done' : 'flash'}
          size={12}
          color="#ffffff"
        />
      </View>
    </Pressable>
  );
}

/**
 * Ephemeral image content — shows blurred thumbnail before viewing, placeholder after expiry
 */
function EphemeralImageContent({
  body,
  expiryDatetime,
  onPress,
  onLongPress,
}: {
  body: string;
  expiryDatetime: number | null;
  onPress?: () => void;
  onLongPress?: (e: GestureResponderEvent) => void;
}) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }, [body]);

  const isSender = !parsed.mediaId;
  const isExpired = parsed.expired === true || (expiryDatetime !== null && Date.now() >= expiryDatetime);
  const viewDuration = parsed.viewDuration || 0;

  // Calculate display dimensions
  const displayDimensions = useMemo(() => {
    const width = parsed.width || 0;
    const height = parsed.height || 0;

    if (!width || !height) {
      return { width: 180, height: 180 };
    }

    const aspectRatio = width / height;
    let displayWidth = width;
    let displayHeight = height;

    if (displayWidth > MAX_IMAGE_WIDTH) {
      displayWidth = MAX_IMAGE_WIDTH;
      displayHeight = displayWidth / aspectRatio;
    }

    if (displayHeight > MAX_IMAGE_HEIGHT) {
      displayHeight = MAX_IMAGE_HEIGHT;
      displayWidth = displayHeight * aspectRatio;
    }

    displayWidth = Math.max(displayWidth, 100);
    displayHeight = Math.max(displayHeight, 100);

    return { width: Math.round(displayWidth), height: Math.round(displayHeight) };
  }, [parsed]);

  if (isExpired || isSender) {
    return (
      <Pressable
        onLongPress={onLongPress}
        className="rounded-lg bg-gray-700/50 items-center justify-center flex-row gap-2"
        style={{ paddingHorizontal: 16, paddingVertical: 14 }}
      >
        <Ionicons name="timer-outline" size={18} color="#9ca3af" />
        <Text className="text-sm text-gray-400">
          {isExpired ? i18next.t('chat.imageExpired') : `${viewDuration}s`}
        </Text>
      </Pressable>
    );
  }

  const thumbnailUri = parsed.thumbnail
    ? `data:image/jpeg;base64,${parsed.thumbnail}`
    : '';

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} className="rounded-lg overflow-hidden">
      <View style={{ width: displayDimensions.width, height: displayDimensions.height }}>
        {thumbnailUri ? (
          <Image
            source={{ uri: thumbnailUri }}
            style={{ width: displayDimensions.width, height: displayDimensions.height }}
            contentFit="cover"
          />
        ) : (
          <View
            className="bg-gray-700"
            style={{ width: displayDimensions.width, height: displayDimensions.height }}
          />
        )}
        {/* Dark overlay */}
        <View
          className="absolute inset-0 items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
        >
          <Ionicons name="timer-outline" size={28} color="#ffffff" />
          <Text className="text-white text-sm font-semibold mt-1">{viewDuration}s</Text>
          <Text className="text-white/70 text-xs mt-1">{i18next.t('chat.tapToView')}</Text>
        </View>
        {/* Timer badge */}
        <View
          className="absolute bottom-1.5 left-1.5 rounded-full items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)', width: 22, height: 22 }}
        >
          <Ionicons name="timer-outline" size={12} color="#ffffff" />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Audio message content (placeholder)
 */
function AudioContent({ body }: { body: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <View className="w-8 h-8 rounded-full bg-white/20 items-center justify-center">
        <Ionicons name="play" size={16} color="#fff" />
      </View>
      <View className="flex-1 h-1 bg-white/30 rounded-full">
        <View className="w-1/3 h-full bg-white rounded-full" />
      </View>
      <Text className="text-xs text-white/70">0:00</Text>
    </View>
  );
}

/**
 * Location message content (placeholder)
 */
function LocationContent({ body }: { body: string }) {
  let location = { latitude: 0, longitude: 0, name: 'Location' };
  try {
    const parsed = JSON.parse(body);
    location = { ...location, ...parsed };
  } catch {}

  return (
    <View className="flex-row items-center gap-2">
      <Ionicons name="location" size={20} color="#fff" />
      <Text className="text-white">{location.name || 'Shared location'}</Text>
    </View>
  );
}

/**
 * Parse file body JSON into structured data.
 * Body shapes:
 *  - sender optimistic: { fileName, fileSize, mimeType, sourceUri, ephemeral }
 *  - persisted (sender or receiver-after-download): + filePath, mediaId, mediaKey, iv
 *  - receiver pre-download: only metadata + mediaId/mediaKey/iv (no filePath)
 */
function parseFileBody(body: string) {
  let parsed: any = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = {};
  }
  return {
    fileName: (parsed.fileName as string) || 'file',
    fileSize: (parsed.fileSize as number) || 0,
    mimeType: (parsed.mimeType as string) || 'application/octet-stream',
    mediaId: (parsed.mediaId as string) || '',
    mediaKey: (parsed.mediaKey as string) || '',
    iv: (parsed.iv as string) || '',
    filePath: (parsed.filePath as string) || '',
    sourceUri: (parsed.sourceUri as string) || '',
    ephemeral: !!parsed.ephemeral,
    expiresAt: (parsed.expiresAt as number) || 0,
  };
}

/**
 * File / document message content.
 * Tap → download (if needed), decrypt, cache, then open via the system share
 * sheet (so the user can preview, save, or open with another app).
 */
function FileContent({
  message,
  isOwn,
  onLongPress,
}: {
  message: Message;
  isOwn: boolean;
  onLongPress?: (e: GestureResponderEvent) => void;
}) {
  const data = useMemo(() => parseFileBody(message.body), [message.body]);
  const iconInfo = useMemo(() => getFileIcon(data.mimeType, data.fileName), [data.mimeType, data.fileName]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const cardBg = isOwn ? 'rgba(33,54,73,0.08)' : 'rgba(255,255,255,0.10)';
  const titleColor = isOwn ? '#213649' : '#ffffff';
  const metaColor = isOwn ? 'rgba(33,54,73,0.65)' : 'rgba(255,255,255,0.65)';

  const sharePath = useCallback(async (relativePath: string) => {
    const uri = resolveFilePath(relativePath);
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      logger.warn('[FileContent] Sharing not available on this platform');
      return;
    }
    await Sharing.shareAsync(uri, {
      mimeType: data.mimeType,
      dialogTitle: data.fileName,
      UTI: data.mimeType,
    });
  }, [data.fileName, data.mimeType]);

  const handlePress = useCallback(async () => {
    if (busy) return;
    setError(false);

    // Sender optimistic case: file still lives at sourceUri
    if (data.sourceUri && !data.filePath) {
      try {
        await Sharing.shareAsync(data.sourceUri, {
          mimeType: data.mimeType,
          dialogTitle: data.fileName,
          UTI: data.mimeType,
        });
      } catch (err) {
        logger.warn('[FileContent] share sourceUri failed:', err);
      }
      return;
    }

    // Already cached
    if (data.filePath && fileExists(data.filePath)) {
      try {
        await sharePath(data.filePath);
      } catch (err) {
        logger.warn('[FileContent] share cached failed:', err);
        setError(true);
      }
      return;
    }

    // Need to download/decrypt
    if (!data.mediaId || !data.mediaKey || !data.iv) {
      setError(true);
      return;
    }

    setBusy(true);
    try {
      const payload: FileMessagePayload = {
        mediaId: data.mediaId,
        mediaKey: data.mediaKey,
        iv: data.iv,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        ephemeral: data.ephemeral,
        expiresAt: data.expiresAt || undefined,
      };
      const cachedPath = await chatService.downloadAndDecryptFile(message.id, message.idRoom, payload);
      await sharePath(cachedPath);
    } catch (err: any) {
      logger.warn('[FileContent] download failed:', err?.message || err);
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [busy, data, message.id, message.idRoom, sharePath]);

  const downloadable = !!(data.filePath || data.sourceUri || data.mediaId);

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={onLongPress}
      disabled={!downloadable}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 6,
        paddingHorizontal: 6,
        borderRadius: 10,
        backgroundColor: cardBg,
        minWidth: 200,
        maxWidth: 260,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: `${iconInfo.color}22`,
        }}
      >
        {busy ? (
          <ActivityIndicator size="small" color={iconInfo.color} />
        ) : (
          <Ionicons name={iconInfo.icon} size={22} color={iconInfo.color} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={2}
          style={{ color: titleColor, fontSize: 14, fontWeight: '600' }}
        >
          {data.fileName}
        </Text>
        <Text style={{ color: metaColor, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
          {error
            ? i18next.t('chat.downloadFailed')
            : busy
              ? i18next.t('chat.downloading')
              : data.fileSize > 0
                ? formatFileSize(data.fileSize)
                : ''}
          {data.ephemeral && !busy && !error ? ` · ${i18next.t('rooms.ephemeralSend')}` : ''}
        </Text>
      </View>
      {!busy && (
        <Ionicons
          name={data.filePath || data.sourceUri ? 'open-outline' : 'cloud-download-outline'}
          size={18}
          color={metaColor}
        />
      )}
    </Pressable>
  );
}

/**
 * Reply preview for messages with id_parent
 */
function ReplyPreview({
  parent,
  isOwn,
  hasParentId,
  onPress,
}: {
  parent?: Message | null;
  isOwn: boolean;
  hasParentId?: boolean;
  onPress?: () => void;
}) {
  if (!parent && !hasParentId) return null;

  const displayText = parent
    ? getMessagePreview(parent.body, parent.type)
    : i18next.t('chat.deletedMessage');

  return (
    <Pressable
      onPress={onPress}
      className={`px-3 py-2 mb-1 rounded-lg border-l-2 ${
        isOwn
          ? 'bg-black/10 border-[#213649]/40'
          : 'bg-white/10 border-white/50'
      }`}
    >
      <Text className={`text-xs ${isOwn ? 'text-[#213649]/60' : 'text-white/70'}`}>{i18next.t('chat.replyTo')}</Text>
      <Text
        className={`text-sm ${isOwn
          ? (parent ? 'text-[#213649]/80' : 'text-[#213649]/50 italic')
          : (parent ? 'text-white/90' : 'text-white/50 italic')
        }`}
        numberOfLines={1}
      >
        {displayText}
      </Text>
    </Pressable>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  metadata,
  isOwn,
  parentMessage,
  isHighlighted = false,
  onLongPress,
  onImagePress,
  onResend,
  onReplyPress,
}: MessageBubbleProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isOwn ? '#2ad1af' : '#213649';
  const isImage = message.type === UserMessageType.IMAGE || message.type === UserMessageType.PERSISTENT_IMAGE || message.type === UserMessageType.EPHEMERAL_IMAGE;
  const bubbleStyle = isImage
    ? { backgroundColor, paddingRight: 6, paddingLeft: 6, paddingTop: 6 }
    : { backgroundColor };

  const handleLongPress = (e: GestureResponderEvent) => onLongPress?.(message, { pageY: e.nativeEvent.pageY });

  const renderContent = () => {
    switch (message.type) {
      case UserMessageType.IMAGE:
      case UserMessageType.PERSISTENT_IMAGE:
        return (
          <ImageContent
            body={message.body}
            onPress={() => onImagePress?.(message)}
            onLongPress={handleLongPress}
            isPersistent={message.type === UserMessageType.PERSISTENT_IMAGE}
          />
        );
      case UserMessageType.EPHEMERAL_IMAGE:
        return (
          <EphemeralImageContent
            body={message.body}
            expiryDatetime={message.expiryDatetime}
            onPress={() => onImagePress?.(message)}
            onLongPress={handleLongPress}
          />
        );
      case UserMessageType.AUDIO:
        return <AudioContent body={message.body} />;
      case UserMessageType.LOCATION:
        return <LocationContent body={message.body} />;
      case UserMessageType.FILE:
        return <FileContent message={message} isOwn={isOwn} onLongPress={handleLongPress} />;
      case UserMessageType.TEXT:
      default:
        return <TextContent body={message.body} isOwn={isOwn} />;
    }
  };

  return (
    <View className={`mb-1 ${metadata.showHeader ? 'mt-3' : ''} ${isOwn ? 'items-end' : 'items-start'}`}>
      {/* Date separator */}
      {metadata.showDateSeparator && (
        <View className="w-full items-center my-4">
          <Text className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
            {metadata.dateText}
          </Text>
        </View>
      )}

      {/* Username for group chats */}
      {metadata.username && metadata.showHeader && (
        <Text
          className={`text-xs mb-1 ${isOwn ? 'mr-3' : 'ml-3'}`}
          style={{ color: backgroundColor }}
        >
          {metadata.username}
        </Text>
      )}

      {/* Message bubble */}
      <Pressable
        onLongPress={(e: GestureResponderEvent) => onLongPress?.(message, { pageY: e.nativeEvent.pageY })}
        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
          isOwn
            ? 'rounded-br-md'
            : 'rounded-bl-md'
        }`}
        style={[
          bubbleStyle,
          {
            borderWidth: 2,
            borderColor: isHighlighted
              ? (isOwn ? (isDark ? '#ffffff' : '#213649') : '#2ad1af')
              : 'transparent',
          },
        ]}
      >
        {/* Reply preview */}
        {message.idParent && (
          <ReplyPreview
            parent={parentMessage}
            isOwn={isOwn}
            hasParentId={!!message.idParent}
            onPress={message.idParent ? () => onReplyPress?.(message.idParent!) : undefined}
          />
        )}

        {/* Message content */}
        {renderContent()}

        {/* Time and status */}
        <View className={`flex-row items-center mt-1 gap-1 ${isOwn ? 'justify-end' : ''}`}>
          <Text className={`text-xs ${isOwn ? 'text-[#213649]/60' : 'text-white/70'}`}>{metadata.time}</Text>
          {isOwn && <StatusIcon status={message.idStatus} />}
        </View>
      </Pressable>

      {/* Retry button */}
      {isOwn && message.idStatus === MessageStatus.UNDELIVERED && (
        <Pressable
          onPress={() => onResend?.(message)}
          className="flex-row items-center self-end mt-1.5 mr-1 px-3 py-1.5 rounded-full bg-amber-500/15"
        >
          <Ionicons name="refresh-outline" size={16} color="#f59e0b" />
          <Text className="text-xs text-amber-600 ml-1.5 font-medium">
            {i18next.t('chat.retryUndelivered')}
          </Text>
        </Pressable>
      )}
      {isOwn && message.idStatus === MessageStatus.FAILED && (
        <Pressable
          onPress={() => onResend?.(message)}
          className="flex-row items-center self-end mt-1.5 mr-1 px-3 py-1.5 rounded-full bg-red-500/15"
        >
          <Ionicons name="refresh-outline" size={16} color="#ef4444" />
          <Text className="text-xs text-red-500 ml-1.5 font-medium">
            {i18next.t('chat.retryFailed')}
          </Text>
        </Pressable>
      )}
    </View>
  );
});
