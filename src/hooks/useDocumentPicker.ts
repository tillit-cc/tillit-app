import { useCallback, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MAX_FILE_SIZE, formatFileSize } from '@/utils/file';
import { logger } from '@/utils/logger';

export interface PickedDocument {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export function useDocumentPicker() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  // Re-entrancy guard: expo-document-picker rejects concurrent calls with
  // ERR_PICKING_IN_PROGRESS. A double-tap on the attach option (or any
  // double-render) was enough to trigger it, so we serialize at the hook level.
  const pickingRef = useRef(false);

  const pickDocument = useCallback(async (): Promise<PickedDocument | null> => {
    if (pickingRef.current) return null;
    pickingRef.current = true;
    setIsLoading(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return null;
      }

      const asset = result.assets[0];
      const size = asset.size ?? 0;

      if (size > MAX_FILE_SIZE) {
        Alert.alert(
          t('common.error'),
          t('chat.fileTooLarge', { max: formatFileSize(MAX_FILE_SIZE) }),
        );
        return null;
      }

      return {
        uri: asset.uri,
        name: asset.name || 'file',
        mimeType: asset.mimeType || 'application/octet-stream',
        size,
      };
    } catch (error: any) {
      // Swallow concurrent-pick errors silently — they only happen when the
      // user double-taps and the second call is meaningless anyway.
      if (error?.code === 'ERR_PICKING_IN_PROGRESS') {
        logger.warn('[useDocumentPicker] picker already running, ignored');
        return null;
      }
      logger.error('[useDocumentPicker] pick error:', error);
      Alert.alert(t('common.error'), t('chat.documentPickError'));
      return null;
    } finally {
      pickingRef.current = false;
      setIsLoading(false);
    }
  }, [t]);

  return {
    pickDocument,
    isLoading,
  };
}
