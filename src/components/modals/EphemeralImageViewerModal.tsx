import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  useWindowDimensions,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { preventScreenCaptureAsync, allowScreenCaptureAsync } from 'expo-screen-capture';

import { SecureView } from 'secure-view';
import { Message } from '@/db/schema';
import { mediaCryptoService } from '@/services/media-crypto.service';
import { serverRegistry } from '@/services/server-registry';
import { messageRepository } from '@/db/repositories/message.repository';
import { useChatStore } from '@/stores/chat.store';
import { logger } from '@/utils/logger';

interface EphemeralImageViewerModalProps {
  visible: boolean;
  message: Message | null;
  roomId: number;
  onClose: () => void;
}

export function EphemeralImageViewerModal({
  visible,
  message,
  roomId,
  onClose,
}: EphemeralImageViewerModalProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { t } = useTranslation();

  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [hasError, setHasError] = useState(false);

  // Prevent screenshots only while the modal is visible.
  // We avoid `usePreventScreenCapture` because it always activates on mount
  // (its default key kicks in when undefined is passed), which would blank
  // the chat screen as soon as the modal is mounted with visible=false.
  useEffect(() => {
    if (!visible) return;
    preventScreenCaptureAsync('ephemeral-viewer');
    return () => {
      allowScreenCaptureAsync('ephemeral-viewer');
    };
  }, [visible]);

  // Animated progress bar
  const progress = useSharedValue(1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageRef = useRef<string | null>(null);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  const cleanup = useCallback(() => {
    // Zero the image buffer
    imageRef.current = null;
    setImageBase64(null);
    setCountdown(0);
    setHasError(false);
    setIsLoading(false);
    progress.value = 1;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [progress]);

  const expireMessage = useCallback(async (msg: Message, viewDuration: number) => {
    try {
      const expiredBody = JSON.stringify({
        expired: true,
        viewDuration,
      });
      await messageRepository.updateBody(msg.id, expiredBody);
      await messageRepository.updateExpiry(msg.id, Date.now());
      useChatStore.getState().updateMessage(roomId, msg.id, {
        body: expiredBody,
        expiryDatetime: Date.now(),
      });

      // Notify server that the image was viewed (best-effort, fire and forget)
      try {
        const parsed = JSON.parse(msg.body);
        if (parsed.mediaId) {
          const api = serverRegistry.getApiForRoom(roomId);
          api.viewedMedia(parsed.mediaId).catch(() => {});
        }
      } catch {}
    } catch (error) {
      logger.error('[EphemeralViewer] expireMessage error:', error);
    }
  }, [roomId]);

  // Load and display the image when the modal opens
  useEffect(() => {
    if (!visible || !message) {
      cleanup();
      return;
    }

    let cancelled = false;

    const loadImage = async () => {
      setIsLoading(true);
      setHasError(false);

      try {
        const parsed = JSON.parse(message.body);
        const { mediaId, mediaKey, iv, viewDuration } = parsed;

        if (!mediaId || !mediaKey || !iv) {
          throw new Error('Missing media encryption data');
        }

        // Download encrypted blob
        const api = serverRegistry.getApiForRoom(roomId);
        const encryptedArrayBuffer = await api.downloadMedia(mediaId);

        if (cancelled) return;

        // Convert ArrayBuffer to base64
        const bytes = new Uint8Array(encryptedArrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const encryptedBase64 = btoa(binary);

        // Decrypt in memory (never written to disk)
        const decryptedBase64 = await mediaCryptoService.decrypt(encryptedBase64, mediaKey, iv);

        if (cancelled) return;

        // Set expiry
        const expiryTime = Date.now() + viewDuration * 1000;
        await messageRepository.updateExpiry(message.id, expiryTime);
        useChatStore.getState().updateMessage(roomId, message.id, {
          expiryDatetime: expiryTime,
        });

        // Display
        imageRef.current = decryptedBase64;
        setImageBase64(decryptedBase64);
        setCountdown(viewDuration);
        setIsLoading(false);

        // Animate progress bar
        progress.value = 1;
        progress.value = withTiming(0, {
          duration: viewDuration * 1000,
          easing: Easing.linear,
        });

        // Countdown timer
        let remaining = viewDuration;
        timerRef.current = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            // Timer expired — destroy image and close
            imageRef.current = null;
            setImageBase64(null);
            expireMessage(message, viewDuration);
            onClose();
          } else {
            setCountdown(remaining);
          }
        }, 1000);
      } catch (error: any) {
        if (cancelled) return;
        logger.error('[EphemeralViewer] Load failed:', error?.message || error);
        setIsLoading(false);
        setHasError(true);

        // If download failed (410 Gone = already viewed), mark as expired
        if (error?.response?.status === 410) {
          try {
            const parsed = JSON.parse(message.body);
            await expireMessage(message, parsed.viewDuration || 0);
          } catch {}
          Alert.alert(t('common.error'), t('chat.imageExpired'));
          onClose();
        }
      }
    };

    loadImage();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [visible, message?.id]);

  // Calculate display dimensions
  const displayDimensions = React.useMemo(() => {
    if (!message) return { width: screenWidth, height: screenWidth };

    let imgWidth = 0;
    let imgHeight = 0;
    try {
      const parsed = JSON.parse(message.body);
      imgWidth = parsed.width || 0;
      imgHeight = parsed.height || 0;
    } catch {}

    if (!imgWidth || !imgHeight) {
      return { width: screenWidth, height: screenWidth };
    }

    const aspectRatio = imgWidth / imgHeight;
    const maxWidth = screenWidth;
    const maxHeight = screenHeight - insets.top - insets.bottom - 100;

    let displayWidth = maxWidth;
    let displayHeight = displayWidth / aspectRatio;

    if (displayHeight > maxHeight) {
      displayHeight = maxHeight;
      displayWidth = displayHeight * aspectRatio;
    }

    return { width: displayWidth, height: displayHeight };
  }, [message?.body, screenWidth, screenHeight, insets]);

  const handleClose = useCallback(() => {
    if (imageBase64 && message) {
      // Image was displayed — expire it immediately
      try {
        const parsed = JSON.parse(message.body);
        expireMessage(message, parsed.viewDuration || 0);
      } catch {}
    }
    cleanup();
    onClose();
  }, [imageBase64, message, expireMessage, cleanup, onClose]);

  if (!message) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <StatusBar style="light" backgroundColor="rgba(0,0,0,0.98)" />
      <View style={styles.container}>
        {/* Top bar: close button + countdown */}
        <View style={[styles.topBar, { paddingTop: insets.top + 16 }]}>
          <Pressable
            onPress={handleClose}
            style={styles.closeButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={24} color="#ffffff" />
          </Pressable>
          {countdown > 0 && (
            <View style={styles.countdownBadge}>
              <Ionicons name="timer-outline" size={18} color="#ffffff" />
              <Text style={styles.countdownText}>{countdown}s</Text>
            </View>
          )}
        </View>

        {/* Image area */}
        <View style={styles.imageArea}>
          {isLoading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#2ad1af" />
              <Text style={styles.loadingText}>{t('chat.downloadingEphemeral')}</Text>
            </View>
          )}

          {hasError && !isLoading && (
            <View style={styles.loadingContainer}>
              <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
              <Text style={styles.errorText}>{t('chat.ephemeralViewerError')}</Text>
            </View>
          )}

          {imageBase64 && !isLoading && (
            <SecureView style={{ width: displayDimensions.width, height: displayDimensions.height }}>
              <Image
                source={{ uri: `data:image/jpeg;base64,${imageBase64}` }}
                style={{
                  width: displayDimensions.width,
                  height: displayDimensions.height,
                }}
                contentFit="contain"
                transition={200}
              />
            </SecureView>
          )}
        </View>

        {/* Bottom progress bar */}
        {countdown > 0 && (
          <View style={[styles.progressBarContainer, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.progressBarTrack}>
              <Animated.View style={[styles.progressBarFill, progressStyle]} />
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.98)',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
    zIndex: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  closeButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  countdownBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  countdownText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  imageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    marginTop: 8,
  },
  progressBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
  },
  progressBarTrack: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#2ad1af',
    borderRadius: 2,
  },
});
