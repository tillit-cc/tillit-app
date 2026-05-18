import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, TextInput, Pressable, Text, Platform } from 'react-native';
import Reanimated, { FadeIn, FadeOut, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Message } from '@/db/schema';
import { chatService } from '@/services/chat.service';
import { getMessagePreview } from '@/utils/message-preview';

interface MessageBarProps {
  onSend: (text: string, parentId?: string) => void;
  onAttach?: () => void;
  replyMessage?: Message | null;
  onCloseReply?: () => void;
  disabled?: boolean;
  placeholder?: string;
  isTyping?: boolean;
  roomId?: number;
}

export function MessageBar({
  onSend,
  onAttach,
  replyMessage,
  onCloseReply,
  disabled = false,
  placeholder,
  isTyping = false,
  roomId,
}: MessageBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const dummyRef = useRef<TextInput>(null);
  // Mirror of `text` state — always up-to-date, readable inside async callbacks
  // without stale closures (e.g. after blur-triggered onChangeText).
  const textRef = useRef('');
  // Typing indicator animation values (Reanimated, UI thread)
  const typingWidth = useSharedValue(0);
  const typingOpacity = useSharedValue(0);

  const canSend = !disabled && text.trim().length > 0;

  // Typing indicator animated style (Reanimated, UI thread)
  const typingBarStyle = useAnimatedStyle(() => ({
    opacity: typingOpacity.value,
    width: `${typingWidth.value * 100}%`,
  }));

  // Typing indicator animation: fast slide-in, stays solid, fade-out on stop
  useEffect(() => {
    if (isTyping) {
      typingOpacity.value = withTiming(1, { duration: 150 });
      typingWidth.value = withTiming(1, { duration: 400 });
    } else {
      typingOpacity.value = withTiming(0, { duration: 200 });
      typingWidth.value = withTiming(0, { duration: 200 });
    }
  }, [isTyping]);

  const handleTextChange = useCallback(
    (newText: string) => {
      textRef.current = newText;
      setText(newText);
      if (roomId == null) return;
      if (newText.length > 0) {
        chatService.sendTypingIndicator(roomId);
      } else {
        chatService.sendTypingStopped(roomId);
      }
    },
    [roomId]
  );

  const doSend = useCallback(() => {
    const trimmedText = textRef.current.trim();
    if (!trimmedText || disabled) return;

    onSend(trimmedText, replyMessage?.id);
    textRef.current = '';
    setText('');
    // On iOS, clear() + setText('') may not dismiss an active inline
    // autocorrect suggestion. A second clear() after the React re-render
    // ensures the native text view is fully reset.
    if (Platform.OS === 'ios') {
      requestAnimationFrame(() => {
        inputRef.current?.clear();
        inputRef.current?.focus();
      });
    } else {
      inputRef.current?.clear();
      inputRef.current?.focus();
    }

    // Stop typing indicator on send
    if (roomId != null) {
      chatService.sendTypingStopped(roomId);
    }

    if (replyMessage) {
      onCloseReply?.();
    }
  }, [disabled, onSend, replyMessage, onCloseReply, roomId]);

  const handleSend = useCallback(() => {
    if (!canSend) return;

    if (Platform.OS === 'ios' && dummyRef.current) {
      // Transfer focus to a hidden input so the main TextInput
      // resignFirstResponder, which commits the pending autocorrect.
      // The keyboard stays visible because iOS does not fire
      // keyboardWillHide when focus transfers between text inputs.
      // doSend runs on the next frame so onChangeText has time to
      // update textRef with the committed text.
      dummyRef.current.focus();
      requestAnimationFrame(doSend);
    } else {
      doSend();
    }
  }, [canSend, doSend]);

  const handleKeyPress = useCallback(
    (e: any) => {
      // On desktop, Enter sends (Shift+Enter for newline)
      if (Platform.OS === 'web' || Platform.OS === 'macos') {
        if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      }
    },
    [handleSend]
  );

  return (
    <View className="bg-transparent border-t border-gray-200 dark:border-gray-800">
      {/* Typing indicator line */}
      <Reanimated.View
        style={[{
          position: 'absolute',
          top: 0,
          left: 0,
          height: 2,
          backgroundColor: '#2ad1af',
          zIndex: 10,
        }, typingBarStyle]}
      />

      {/* Reply preview */}
      {replyMessage && (
        <Reanimated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          className="bg-gray-50 dark:bg-gray-800"
        >
          <View className="flex-row items-center px-4 py-2">
            <View className="flex-1 border-l-2 pl-3" style={{ borderLeftColor: '#2ad1af' }}>
              <Text className="text-xs font-medium" style={{ color: '#2ad1af' }}>{t('chat.reply')}</Text>
              <Text
                className="text-sm text-gray-600 dark:text-gray-400"
                numberOfLines={1}
              >
                {getMessagePreview(replyMessage.body, replyMessage.type)}
              </Text>
            </View>
            <Pressable
              onPress={onCloseReply}
              className="p-2"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={20} color="#6b7280" />
            </Pressable>
          </View>
        </Reanimated.View>
      )}

      {/* Hidden input — holds keyboard while main input commits autocorrect */}
      {Platform.OS === 'ios' && (
        <TextInput
          ref={dummyRef}
          style={{ position: 'absolute', left: -9999, width: 100, height: 40 }}
        />
      )}

      {/* Input bar */}
      <View className="flex-row items-center px-2 py-2 gap-2">
        {/* Attachment button */}
        <Pressable
          onPress={onAttach}
          disabled={disabled}
          className={`w-8 h-8 items-center justify-center rounded-full ${
            disabled ? 'opacity-50' : ''
          }`}
          style={{ borderWidth: 2, borderColor: disabled ? '#9ca3af' : '#2ad1af' }}
        >
          <Ionicons
            name="add"
            size={20}
            color={disabled ? '#9ca3af' : '#2ad1af'}
          />
        </Pressable>

        {/* Text input */}
        <View className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 justify-center min-h-[40px] max-h-[120px]">
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={handleTextChange}
            onKeyPress={handleKeyPress}
            placeholder={disabled ? t('chat.sessionNotEstablished') : (placeholder || t('chat.writeMessage'))}
            placeholderTextColor="#9ca3af"
            multiline
            autoCapitalize="sentences"
            maxLength={5000}
            editable={!disabled}
            className="text-base text-gray-900 dark:text-white max-h-[100px]"
            style={{ paddingTop: 4, paddingBottom: 10, textAlignVertical: 'center' }}
          />
        </View>

        {/* Send button */}
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          className={`w-10 h-10 items-center justify-center rounded-full ${
            canSend ? '' : 'bg-gray-200 dark:bg-gray-700'
          }`}
          style={canSend ? { backgroundColor: '#2ad1af' } : undefined}
        >
          <Ionicons
            name="send"
            size={20}
            color={canSend ? '#fff' : '#9ca3af'}
          />
        </Pressable>
      </View>
    </View>
  );
}
