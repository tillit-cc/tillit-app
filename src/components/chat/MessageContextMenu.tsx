import React, { useEffect } from 'react';
import { View, Text, Pressable, Modal, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { Message } from '@/db/schema';

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 50;
const MENU_MARGIN = 24;
const MENU_OFFSET = 8;

interface MessageContextMenuProps {
  visible: boolean;
  message: Message | null;
  pressY: number;
  isOwn: boolean;
  hasLink?: boolean;
  onReply: () => void;
  onCopyText: () => void;
  onCopyLink?: () => void;
  onDelete: () => void;
  onReport: () => void;
  onClose: () => void;
}

export function MessageContextMenu({
  visible,
  message,
  pressY,
  isOwn,
  hasLink = false,
  onReply,
  onCopyText,
  onCopyLink,
  onDelete,
  onReport,
  onClose,
}: MessageContextMenuProps) {
  const { height: screenHeight } = useWindowDimensions();
  const { t } = useTranslation();

  // Haptic feedback when menu opens
  useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, [visible]);

  if (!visible || !message) return null;

  // Compute visible items count: Reply + (CopyText) + (CopyLink?) + (Report?) + Delete
  const showCopyLink = hasLink && !!onCopyLink;
  const showReport = !isOwn;
  const itemsCount = 2 /* Reply, CopyText */ + (showCopyLink ? 1 : 0) + (showReport ? 1 : 0) + 1 /* Delete */;
  const menuHeight = itemsCount * ITEM_HEIGHT;

  // Position menu above or below the press point
  const showAbove = pressY > screenHeight / 2;
  const menuTop = showAbove ? pressY - menuHeight - MENU_OFFSET : pressY + MENU_OFFSET;

  // Horizontal position: right for own messages, left for others
  const horizontalStyle = isOwn
    ? { right: MENU_MARGIN }
    : { left: MENU_MARGIN };

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable
        onPress={onClose}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)' }}
      />

      {/* Menu card */}
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(100)}
        style={[
          {
            position: 'absolute',
            top: menuTop,
            width: MENU_WIDTH,
            borderRadius: 12,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.25,
            shadowRadius: 8,
            elevation: 5,
            overflow: 'hidden',
          },
          horizontalStyle,
        ]}
        className="bg-white dark:bg-gray-800"
      >
        {/* Reply */}
        <Pressable
          onPress={wrap(onReply)}
          className="flex-row items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 active:bg-gray-100 dark:active:bg-gray-700"
          style={{ height: ITEM_HEIGHT }}
        >
          <Ionicons name="arrow-undo" size={20} color="#6b7280" />
          <Text className="ml-3 text-base text-gray-900 dark:text-white">
            {t('chat.replyAction')}
          </Text>
        </Pressable>

        {/* Copy text */}
        <Pressable
          onPress={wrap(onCopyText)}
          className="flex-row items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 active:bg-gray-100 dark:active:bg-gray-700"
          style={{ height: ITEM_HEIGHT }}
        >
          <Ionicons name="copy-outline" size={20} color="#6b7280" />
          <Text className="ml-3 text-base text-gray-900 dark:text-white">
            {t('chat.copyText')}
          </Text>
        </Pressable>

        {/* Copy link — only when message contains a link */}
        {showCopyLink && (
          <Pressable
            onPress={wrap(onCopyLink!)}
            className="flex-row items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 active:bg-gray-100 dark:active:bg-gray-700"
            style={{ height: ITEM_HEIGHT }}
          >
            <Ionicons name="link-outline" size={20} color="#6b7280" />
            <Text className="ml-3 text-base text-gray-900 dark:text-white">
              {t('chat.copyLink')}
            </Text>
          </Pressable>
        )}

        {/* Report — only for other people's messages */}
        {showReport && (
          <Pressable
            onPress={wrap(onReport)}
            className="flex-row items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 active:bg-gray-100 dark:active:bg-gray-700"
            style={{ height: ITEM_HEIGHT }}
          >
            <Ionicons name="flag-outline" size={20} color="#f59e0b" />
            <Text className="ml-3 text-base text-gray-900 dark:text-white">
              {t('report.reportAction')}
            </Text>
          </Pressable>
        )}

        {/* Delete */}
        <Pressable
          onPress={wrap(onDelete)}
          className="flex-row items-center px-4 py-3 active:bg-gray-100 dark:active:bg-gray-700"
          style={{ height: ITEM_HEIGHT }}
        >
          <Ionicons name="trash-outline" size={20} color="#ef4444" />
          <Text className="ml-3 text-base text-red-500">
            {t('chat.deleteForAll')}
          </Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}
