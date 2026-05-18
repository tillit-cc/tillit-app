import React from 'react';
import { View, Text, Pressable, Modal, Switch, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ImageMode } from './ImagePreviewModal';

interface AttachmentOption {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

interface AttachmentModalProps {
  visible: boolean;
  onClose: () => void;
  onCameraPress: () => void;
  onGalleryPress: () => void;
  onDocumentPress: () => void;
  imageMode: ImageMode;
  onImageModeChange: (mode: ImageMode) => void;
}

export function AttachmentModal({
  visible,
  onClose,
  onCameraPress,
  onGalleryPress,
  onDocumentPress,
  imageMode,
  onImageModeChange,
}: AttachmentModalProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const options: AttachmentOption[] = [
    {
      id: 'camera',
      label: t('rooms.camera'),
      icon: 'camera',
      onPress: () => {
        onClose();
        onCameraPress();
      },
    },
    {
      id: 'gallery',
      label: t('rooms.gallery'),
      icon: 'images',
      onPress: () => {
        onClose();
        onGalleryPress();
      },
    },
    {
      id: 'document',
      label: t('rooms.document'),
      icon: 'document-attach',
      onPress: () => {
        onClose();
        // iOS UIDocumentPickerViewController fails silently when presented
        // while another modal is still dismissing. Wait for the slide-down
        // animation to finish before invoking the picker.
        const delay = Platform.OS === 'ios' ? 400 : 0;
        setTimeout(() => onDocumentPress(), delay);
      },
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1 }}>
        <Pressable
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          onPress={onClose}
        />

        <View
          className="bg-white dark:bg-gray-900 rounded-t-3xl mt-auto"
          style={{ paddingBottom: insets.bottom + 16 }}
        >
          {/* Handle bar */}
          <View className="items-center pt-3 pb-2">
            <View className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
          </View>

          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
            <View className="w-10" />
            <Text className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('rooms.sendAttachment')}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              className="w-10 items-end"
            >
              <Ionicons name="close" size={24} color="#9ca3af" />
            </Pressable>
          </View>

          {/* Image mode toggle */}
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
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
              onValueChange={(val) => onImageModeChange(val ? 'persistent' : 'volatile')}
              trackColor={{ false: '#767577', true: '#2ad1af' }}
              thumbColor="#ffffff"
            />
          </View>

          {/* Options */}
          <View className="px-4 py-4">
            {options.map((option, index) => (
              <Pressable
                key={option.id}
                onPress={option.onPress}
                className={`flex-row items-center py-4 ${
                  index < options.length - 1
                    ? 'border-b border-gray-200 dark:border-gray-800'
                    : ''
                }`}
              >
                <View
                  className="w-12 h-12 rounded-full items-center justify-center mr-4"
                  style={{ backgroundColor: '#2ad1af' }}
                >
                  <Ionicons name={option.icon} size={24} color="#ffffff" />
                </View>
                <Text className="text-base text-gray-900 dark:text-white flex-1">
                  {option.label}
                </Text>
                <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
              </Pressable>
            ))}
          </View>

          {/* Cancel button */}
          <View className="px-4">
            <Pressable
              onPress={onClose}
              className="bg-gray-100 dark:bg-gray-800 rounded-xl py-4 items-center"
            >
              <Text className="text-base font-medium text-gray-900 dark:text-white">
                {t('common.cancel')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
