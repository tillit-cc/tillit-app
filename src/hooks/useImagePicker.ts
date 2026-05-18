import { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';
import { logger } from '@/utils/logger';

export interface PickedImage {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

interface UseImagePickerOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export function useImagePicker(options: UseImagePickerOptions = {}) {
  const { quality = 0.7, maxWidth = 1280, maxHeight = 1280 } = options;
  const [isLoading, setIsLoading] = useState(false);

  const requestCameraPermission = useCallback(async (): Promise<boolean> => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permesso richiesto',
        'Per scattare foto, devi consentire l\'accesso alla fotocamera nelle impostazioni.',
        [{ text: 'OK' }]
      );
      return false;
    }
    return true;
  }, []);

  const requestMediaLibraryPermission = useCallback(async (): Promise<boolean> => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permesso richiesto',
        'Per selezionare foto, devi consentire l\'accesso alla galleria nelle impostazioni.',
        [{ text: 'OK' }]
      );
      return false;
    }
    return true;
  }, []);

  const processResult = useCallback((result: ImagePicker.ImagePickerResult): PickedImage | null => {
    if (result.canceled || !result.assets || result.assets.length === 0) {
      return null;
    }

    const asset = result.assets[0];
    if (!asset.base64) {
      logger.error('[useImagePicker] No base64 data in result');
      return null;
    }

    // Calculate approximate size from base64 length
    // base64 encoding adds ~33% overhead, so size = base64Length * 0.75
    const size = Math.round(asset.base64.length * 0.75);

    return {
      base64: asset.base64,
      mimeType: asset.mimeType || 'image/jpeg',
      width: asset.width,
      height: asset.height,
      size,
    };
  }, []);

  const pickFromCamera = useCallback(async (): Promise<PickedImage | null> => {
    const hasPermission = await requestCameraPermission();
    if (!hasPermission) return null;

    setIsLoading(true);
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality,
        base64: true,
        exif: false,
      });

      return processResult(result);
    } catch (error) {
      logger.error('[useImagePicker] Camera error:', error);
      Alert.alert('Errore', 'Impossibile scattare la foto. Riprova.');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [quality, requestCameraPermission, processResult]);

  const pickFromGallery = useCallback(async (): Promise<PickedImage | null> => {
    const hasPermission = await requestMediaLibraryPermission();
    if (!hasPermission) return null;

    setIsLoading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality,
        base64: true,
        exif: false,
      });

      return processResult(result);
    } catch (error) {
      logger.error('[useImagePicker] Gallery error:', error);
      Alert.alert('Errore', 'Impossibile selezionare la foto. Riprova.');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [quality, requestMediaLibraryPermission, processResult]);

  return {
    pickFromCamera,
    pickFromGallery,
    isLoading,
  };
}
