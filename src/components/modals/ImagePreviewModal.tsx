import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { PickedImage } from '@/hooks/useImagePicker';
import { EPHEMERAL_DURATIONS, EPHEMERAL_TTL_OPTIONS } from '@/config/app.config';

export type ImageMode = 'volatile' | 'persistent' | 'ephemeral';

interface ImagePreviewModalProps {
  visible: boolean;
  image: PickedImage | null;
  imageMode: ImageMode;
  onImageModeChange: (mode: ImageMode) => void;
  ephemeralDuration: number;
  onEphemeralDurationChange: (duration: number) => void;
  ephemeralTtlHours: number;
  onEphemeralTtlHoursChange: (hours: number) => void;
  onSend: () => void;
  onCancel: () => void;
}

const MODE_OPTIONS: { mode: ImageMode; icon: keyof typeof Ionicons.glyphMap; labelKey: string; descKey: string }[] = [
  { mode: 'persistent', icon: 'cloud-done', labelKey: 'rooms.saveToServer', descKey: 'rooms.saveToServerDesc' },
  { mode: 'volatile', icon: 'flash', labelKey: 'rooms.directSend', descKey: 'rooms.directSendDesc' },
  { mode: 'ephemeral', icon: 'timer-outline', labelKey: 'rooms.ephemeralSend', descKey: 'rooms.ephemeralSendDesc' },
];

export function ImagePreviewModal({
  visible,
  image,
  imageMode,
  onImageModeChange,
  ephemeralDuration,
  onEphemeralDurationChange,
  ephemeralTtlHours,
  onEphemeralTtlHoursChange,
  onSend,
  onCancel,
}: ImagePreviewModalProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { t } = useTranslation();

  if (!image) return null;

  const uri = `data:${image.mimeType};base64,${image.base64}`;

  // Calculate display dimensions maintaining aspect ratio
  const aspectRatio = image.width / image.height;
  const maxWidth = screenWidth - 32;
  const maxHeight = screenHeight - insets.top - insets.bottom - 280;

  let displayWidth = maxWidth;
  let displayHeight = displayWidth / aspectRatio;

  if (displayHeight > maxHeight) {
    displayHeight = maxHeight;
    displayWidth = displayHeight * aspectRatio;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={styles.container}>
        {/* Close button */}
        <Pressable
          onPress={onCancel}
          style={[styles.closeButton, { top: insets.top + 16 }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={28} color="#ffffff" />
        </Pressable>

        {/* Image preview */}
        <View style={styles.imageArea}>
          <Image
            source={{ uri }}
            style={{ width: displayWidth, height: displayHeight }}
            contentFit="contain"
            transition={200}
          />
        </View>

        {/* Bottom controls */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          {/* Mode selector: 3 pills */}
          <View style={styles.modeRow}>
            {MODE_OPTIONS.map((opt) => {
              const isActive = imageMode === opt.mode;
              return (
                <Pressable
                  key={opt.mode}
                  onPress={() => onImageModeChange(opt.mode)}
                  style={[styles.modePill, isActive && styles.modePillActive]}
                >
                  <Ionicons
                    name={opt.icon}
                    size={16}
                    color={isActive ? '#ffffff' : 'rgba(255,255,255,0.5)'}
                  />
                  <Text
                    style={[
                      styles.modePillText,
                      isActive && styles.modePillTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Duration selector for ephemeral mode */}
          {imageMode === 'ephemeral' && (
            <View style={styles.durationRow}>
              <Text style={styles.durationLabel}>{t('chat.ephemeralDuration')}</Text>
              <View style={styles.durationPills}>
                {EPHEMERAL_DURATIONS.map((d) => {
                  const isActive = ephemeralDuration === d;
                  return (
                    <Pressable
                      key={d}
                      onPress={() => onEphemeralDurationChange(d)}
                      style={[
                        styles.durationPill,
                        isActive && styles.durationPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.durationPillText,
                          isActive && styles.durationPillTextActive,
                        ]}
                      >
                        {d}s
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {/* TTL selector for ephemeral mode */}
          {imageMode === 'ephemeral' && (
            <View style={styles.durationRow}>
              <Text style={styles.durationLabel}>{t('chat.ephemeralTtl')}</Text>
              <View style={styles.durationPills}>
                {EPHEMERAL_TTL_OPTIONS.map((h) => {
                  const isActive = ephemeralTtlHours === h;
                  return (
                    <Pressable
                      key={h}
                      onPress={() => onEphemeralTtlHoursChange(h)}
                      style={[
                        styles.durationPill,
                        isActive && styles.durationPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.durationPillText,
                          isActive && styles.durationPillTextActive,
                        ]}
                      >
                        {h}h
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {/* Send button */}
          <Pressable onPress={onSend} style={styles.sendButton}>
            <Ionicons
              name={imageMode === 'ephemeral' ? 'timer-outline' : 'send'}
              size={22}
              color="#ffffff"
            />
          </Pressable>
        </View>
      </View>
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
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 10,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  modePillActive: {
    backgroundColor: 'rgba(42,209,175,0.25)',
    borderWidth: 1,
    borderColor: '#2ad1af',
  },
  modePillText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.5)',
  },
  modePillTextActive: {
    color: '#ffffff',
  },
  durationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  durationLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
  },
  durationPills: {
    flexDirection: 'row',
    gap: 8,
  },
  durationPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  durationPillActive: {
    backgroundColor: '#2ad1af',
  },
  durationPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.5)',
  },
  durationPillTextActive: {
    color: '#ffffff',
  },
  sendButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#2ad1af',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
  },
});
