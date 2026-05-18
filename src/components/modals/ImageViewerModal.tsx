import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { View, Pressable, Modal, useWindowDimensions, Alert, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';
import { buildFullImageUri } from '@/components/chat/MessageBubble';
import { ensureImageFileUri } from '@/utils/image';
import { logger } from '@/utils/logger';

interface ImageViewerModalProps {
  visible: boolean;
  imageData: string | null;
  onClose: () => void;
}

export function ImageViewerModal({
  visible,
  imageData,
  onClose,
}: ImageViewerModalProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  // --- Zoom/Pan shared values ---
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Reset zoom when modal opens/closes
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [visible]);

  // Parse image data to get URI and dimensions
  const { uri, width, height } = useMemo(() => {
    if (!imageData) return { uri: '', width: 0, height: 0 };

    let imgWidth = 0;
    let imgHeight = 0;

    try {
      const parsed = JSON.parse(imageData);
      imgWidth = parsed.width || 0;
      imgHeight = parsed.height || 0;
    } catch {
      // Raw base64 string — no dimensions available
    }

    const finalUri = buildFullImageUri(imageData);

    return { uri: finalUri, width: imgWidth, height: imgHeight };
  }, [imageData]);

  // Calculate display dimensions to fit screen while maintaining aspect ratio
  const displayDimensions = useMemo(() => {
    if (!width || !height) {
      return { width: screenWidth, height: screenWidth };
    }

    const aspectRatio = width / height;
    const maxWidth = screenWidth;
    const maxHeight = screenHeight - insets.top - insets.bottom - 100;

    let displayWidth = maxWidth;
    let displayHeight = displayWidth / aspectRatio;

    if (displayHeight > maxHeight) {
      displayHeight = maxHeight;
      displayWidth = displayHeight * aspectRatio;
    }

    return { width: displayWidth, height: displayHeight };
  }, [width, height, screenWidth, screenHeight, insets]);

  // --- Gestures ---
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(savedScale.value * e.scale, 5));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      // Snap back to 1x if barely zoomed
      if (scale.value < 1.1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  const panGesture = Gesture.Pan()
    .minDistance(5)
    .minPointers(1)
    .maxPointers(2)
    .onUpdate((e) => {
      // Only allow panning when zoomed in
      if (savedScale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      }
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      if (scale.value > 1.05) {
        // Reset zoom
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        // Zoom to 2.5x
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
        translateX.value = 0;
        translateY.value = 0;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  const singleTapGesture = Gesture.Tap()
    .maxDuration(250)
    .onEnd(() => {
      // Close only when not zoomed
      if (scale.value <= 1.05) {
        runOnJS(onClose)();
      }
    });

  const composed = Gesture.Race(
    Gesture.Simultaneous(pinchGesture, panGesture),
    Gesture.Exclusive(doubleTapGesture, singleTapGesture),
  );

  const animatedImageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // --- Save / Share ---
  const handleSave = useCallback(async () => {
    if (!imageData || saving) return;
    setSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        setSaving(false);
        return;
      }

      const fileUri = ensureImageFileUri(imageData);
      if (!fileUri) {
        Alert.alert(t('common.error'), t('imageViewer.saveError'));
        setSaving(false);
        return;
      }

      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert(t('imageViewer.saved'), t('imageViewer.savedMsg'));
    } catch (error) {
      logger.error('[ImageViewer] Save failed:', error);
      Alert.alert(t('common.error'), t('imageViewer.saveError'));
    } finally {
      setSaving(false);
    }
  }, [imageData, saving, t]);

  const handleShare = useCallback(async () => {
    if (!imageData) return;
    try {
      const fileUri = ensureImageFileUri(imageData);
      if (!fileUri) {
        Alert.alert(t('common.error'), t('imageViewer.shareError'));
        return;
      }

      let mimeType = 'image/jpeg';
      try {
        const parsed = JSON.parse(imageData);
        if (parsed.mimeType) mimeType = parsed.mimeType;
      } catch {}

      await Sharing.shareAsync(fileUri, { mimeType });
    } catch (error) {
      logger.error('[ImageViewer] Share failed:', error);
      Alert.alert(t('common.error'), t('imageViewer.shareError'));
    }
  }, [imageData, t]);

  if (!imageData) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="light" backgroundColor="rgba(0,0,0,0.95)" />
        <View style={styles.container}>
          {/* Close button */}
          <Pressable
            onPress={onClose}
            style={[styles.closeButton, { top: insets.top + 16 }]}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={28} color="#ffffff" />
          </Pressable>

          {/* Zoomable image */}
          <View style={styles.imageArea}>
            <GestureDetector gesture={composed}>
              <Animated.View style={animatedImageStyle}>
                <Image
                  source={{ uri }}
                  style={{
                    width: displayDimensions.width,
                    height: displayDimensions.height,
                  }}
                  contentFit="contain"
                  transition={200}
                />
              </Animated.View>
            </GestureDetector>
          </View>

          {/* Bottom toolbar */}
          <View
            style={[styles.toolbar, { paddingBottom: insets.bottom + 16 }]}
          >
            <Pressable
              onPress={handleSave}
              disabled={saving}
              style={[styles.toolbarButton, { opacity: saving ? 0.5 : 1 }]}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="download-outline" size={26} color="#ffffff" />
            </Pressable>
            <Pressable
              onPress={handleShare}
              style={styles.toolbarButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="share-outline" size={26} color="#ffffff" />
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  closeButton: {
    position: 'absolute',
    right: 16,
    zIndex: 10,
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  imageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  toolbar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
  },
  toolbarButton: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
});