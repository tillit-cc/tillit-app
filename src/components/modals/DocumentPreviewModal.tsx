import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { PickedDocument } from '@/hooks/useDocumentPicker';
import { formatFileSize, getFileIcon } from '@/utils/file';
import { EPHEMERAL_TTL_OPTIONS } from '@/config/app.config';

export type DocumentMode = 'persistent' | 'ephemeral';

interface DocumentPreviewModalProps {
  visible: boolean;
  document: PickedDocument | null;
  mode: DocumentMode;
  onModeChange: (mode: DocumentMode) => void;
  ephemeralTtlHours: number;
  onEphemeralTtlHoursChange: (hours: number) => void;
  onSend: () => void;
  onCancel: () => void;
}

const MODE_OPTIONS: { mode: DocumentMode; icon: keyof typeof Ionicons.glyphMap; labelKey: string }[] = [
  { mode: 'persistent', icon: 'cloud-done', labelKey: 'rooms.saveToServer' },
  { mode: 'ephemeral', icon: 'timer-outline', labelKey: 'rooms.ephemeralSend' },
];

export function DocumentPreviewModal({
  visible,
  document,
  mode,
  onModeChange,
  ephemeralTtlHours,
  onEphemeralTtlHoursChange,
  onSend,
  onCancel,
}: DocumentPreviewModalProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  if (!document) return null;

  const iconInfo = getFileIcon(document.mimeType, document.name);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={styles.container}>
        <Pressable
          onPress={onCancel}
          style={[styles.closeButton, { top: insets.top + 16 }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={28} color="#ffffff" />
        </Pressable>

        <View style={styles.previewArea}>
          <View style={styles.fileCard}>
            <View style={[styles.iconCircle, { backgroundColor: `${iconInfo.color}20` }]}>
              <Ionicons name={iconInfo.icon} size={48} color={iconInfo.color} />
            </View>
            <Text style={styles.fileName} numberOfLines={2}>{document.name}</Text>
            <Text style={styles.fileMeta}>
              {formatFileSize(document.size)}
              {document.mimeType ? ` · ${document.mimeType}` : ''}
            </Text>
          </View>
        </View>

        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          {/* Mode pills */}
          <View style={styles.modeRow}>
            {MODE_OPTIONS.map((opt) => {
              const isActive = mode === opt.mode;
              return (
                <Pressable
                  key={opt.mode}
                  onPress={() => onModeChange(opt.mode)}
                  style={[styles.modePill, isActive && styles.modePillActive]}
                >
                  <Ionicons
                    name={opt.icon}
                    size={16}
                    color={isActive ? '#ffffff' : 'rgba(255,255,255,0.5)'}
                  />
                  <Text
                    style={[styles.modePillText, isActive && styles.modePillTextActive]}
                    numberOfLines={1}
                  >
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {mode === 'ephemeral' && (
            <View style={styles.durationRow}>
              <Text style={styles.durationLabel}>{t('chat.ephemeralTtl')}</Text>
              <View style={styles.durationPills}>
                {EPHEMERAL_TTL_OPTIONS.map((h) => {
                  const isActive = ephemeralTtlHours === h;
                  return (
                    <Pressable
                      key={h}
                      onPress={() => onEphemeralTtlHoursChange(h)}
                      style={[styles.durationPill, isActive && styles.durationPillActive]}
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

          <Pressable onPress={onSend} style={styles.sendButton}>
            <Ionicons
              name={mode === 'ephemeral' ? 'timer-outline' : 'send'}
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
  previewArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  fileCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  fileName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  fileMeta: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    textAlign: 'center',
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
