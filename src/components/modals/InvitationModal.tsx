import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Share,
  Switch,
  ScrollView,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { chatService } from '@/services/chat.service';
import { useAppStore } from '@/stores/app.store';
import { useServerStore } from '@/stores/server.store';
import { serverRegistry } from '@/services/server-registry';

interface InvitationModalProps {
  visible: boolean;
  onClose: () => void;
  onRoomCreated?: (roomId: number, inviteCode: string) => void;
  onRoomJoined?: () => void;
}

export function InvitationModal({
  visible,
  onClose,
  onRoomCreated,
  onRoomJoined,
}: InvitationModalProps) {
  const { t } = useTranslation();
  const { settings } = useAppStore();
  const servers = useServerStore((s) => s.servers);
  const showServerSelector = servers.length > 1;

  const [username, setUsername] = useState(settings.username || '');
  const [roomName, setRoomName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [administered, setAdministered] = useState(false);

  // Sync username and default server when modal becomes visible
  useEffect(() => {
    if (visible) {
      setUsername(settings.username || '');
      try {
        setSelectedServerId(serverRegistry.getDefaultServerId());
      } catch {
        if (servers.length > 0) setSelectedServerId(servers[0].id);
      }
    }
  }, [visible, settings.username, servers]);

  const handleCreateRoom = useCallback(async () => {
    const name = roomName.trim();
    if (!name || isLoading) return;

    if (!username.trim()) {
      Alert.alert(t('common.warning'), t('rooms.enterNameWarning'));
      return;
    }

    setIsLoading(true);
    setLoadingMessage(t('rooms.creatingRoom'));

    try {
      const { roomId, inviteCode } = await chatService.createRoom(
        name,
        username.trim(),
        selectedServerId ?? undefined,
        administered,
      );
      setCreatedCode(inviteCode);
      setIsLoading(false);
      onRoomCreated?.(roomId, inviteCode);
    } catch (error: any) {
      setIsLoading(false);
      Alert.alert(t('common.error'), error?.message || t('rooms.createRoomError'));
    }
  }, [roomName, username, isLoading, onRoomCreated, selectedServerId, administered]);

  const handleJoinRoom = useCallback(async () => {
    const code = roomCode.trim();
    if (!code || code.length < 6 || isLoading) return;

    if (!username.trim()) {
      Alert.alert(t('common.warning'), t('rooms.enterNameWarning'));
      return;
    }

    setIsLoading(true);
    setLoadingMessage(t('rooms.connectingRoom'));

    try {
      await chatService.joinRoom(code, username.trim(), selectedServerId ?? undefined);
      setIsLoading(false);
      onRoomJoined?.();
      handleClose();
    } catch (error: any) {
      setIsLoading(false);
      Alert.alert(t('common.error'), error?.message || t('rooms.inviteCodeError'));
    }
  }, [roomCode, username, isLoading, onRoomJoined, selectedServerId]);

  const handleClose = useCallback(() => {
    setRoomName('');
    setRoomCode('');
    setCreatedCode('');
    setAdministered(false);
    setIsLoading(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 pt-4 pb-2 border-b border-gray-200 dark:border-gray-700">
          <TouchableOpacity onPress={handleClose} className="p-2">
            <Ionicons name="close" size={24} color="#5d7da3" />
          </TouchableOpacity>
          <Text className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('rooms.newConversation')}
          </Text>
          <View className="w-10" />
        </View>

        {/* Loading overlay */}
        {isLoading && (
          <View className="absolute inset-0 z-50 items-center justify-center bg-black/40">
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-8 items-center mx-8">
              <ActivityIndicator size="large" color="#2ad1af" />
              <Text className="mt-4 text-base text-gray-600 dark:text-gray-300">
                {loadingMessage}
              </Text>
            </View>
          </View>
        )}

        <ScrollView
          className="flex-1 px-6 pt-6"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={Keyboard.dismiss}
        >
          {/* Username */}
          <View className="mb-8">
            <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
              {t('rooms.yourName')}
            </Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder={t('rooms.whatsYourName')}
              className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white"
              placeholderTextColor="#9ca3af"
              autoCapitalize="words"
            />
          </View>

          {/* Created code display */}
          {createdCode ? (
            <View className="mb-8 items-center">
              <View className="bg-gray-100 dark:bg-gray-800 rounded-2xl p-6 items-center w-full">
                <Ionicons name="checkmark-circle" size={48} color="#2ad1af" />
                <Text className="mt-3 text-base text-gray-600 dark:text-gray-300">
                  {t('rooms.roomCreated')}
                </Text>
                <Text className="mt-2 text-3xl font-bold tracking-widest" style={{ color: '#2ad1af' }}>
                  {createdCode}
                </Text>
                <View className="flex-row gap-3 mt-6">
                  <TouchableOpacity
                    onPress={() => {
                      Clipboard.setStringAsync(`https://tillit.cc/roomcode/${createdCode}`);
                      Alert.alert(t('common.copied'), t('common.linkCopied'));
                    }}
                    className="rounded-xl px-6 py-3 flex-row items-center"
                    style={{ backgroundColor: '#213649' }}
                  >
                    <Ionicons name="copy-outline" size={18} color="#fff" />
                    <Text className="text-white font-semibold text-base ml-2">{t('common.copy')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      Share.share({
                        message: t('rooms.shareInvite', { code: createdCode }),
                      });
                    }}
                    className="rounded-xl px-6 py-3 flex-row items-center"
                    style={{ backgroundColor: '#2ad1af' }}
                  >
                    <Ionicons name="share-outline" size={18} color="#fff" />
                    <Text className="text-white font-semibold text-base ml-2">{t('common.share')}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  onPress={handleClose}
                  className="mt-4"
                >
                  <Text className="text-gray-500 text-base">{t('common.close')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <>
              {/* Server selector (only when >1 server) */}
              {showServerSelector && (
                <View className="mb-6">
                  <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
                    {t('rooms.server')}
                  </Text>
                  <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                    {servers.map((server) => {
                      const isSelected = selectedServerId === server.id;
                      return (
                        <TouchableOpacity
                          key={server.id}
                          onPress={() => setSelectedServerId(server.id)}
                          className={`rounded-xl px-4 py-2 border ${
                            isSelected
                              ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/30'
                              : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800'
                          }`}
                        >
                          <Text
                            className={`text-sm font-medium ${
                              isSelected
                                ? 'text-teal-700 dark:text-teal-300'
                                : 'text-gray-700 dark:text-gray-300'
                            }`}
                          >
                            {server.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* Create Room */}
              <View className="mb-8">
                <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
                  {t('rooms.createRoom')}
                </Text>
                <TextInput
                  value={roomName}
                  onChangeText={setRoomName}
                  placeholder={t('rooms.roomNamePlaceholder')}
                  className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-3"
                  placeholderTextColor="#9ca3af"
                />
                <View className="flex-row items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 mb-3">
                  <View className="flex-1 mr-3">
                    <Text className="text-base text-gray-900 dark:text-white">
                      {t('rooms.administeredRoom')}
                    </Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('rooms.administeredRoomDesc')}
                    </Text>
                  </View>
                  <Switch
                    value={administered}
                    onValueChange={setAdministered}
                    trackColor={{ false: '#d1d5db', true: '#2ad1af' }}
                    thumbColor="#fff"
                  />
                </View>
                <TouchableOpacity
                  onPress={handleCreateRoom}
                  disabled={!roomName.trim() || isLoading}
                  className="rounded-xl py-3 items-center"
                  style={{
                    backgroundColor: roomName.trim() ? '#2ad1af' : '#d1d5db',
                  }}
                >
                  <Text className="text-white font-semibold text-base">{t('rooms.createRoomBtn')}</Text>
                </TouchableOpacity>
              </View>

              {/* Divider */}
              <View className="flex-row items-center mb-8">
                <View className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                <Text className="mx-4 text-sm text-gray-400">{t('common.or')}</Text>
                <View className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
              </View>

              {/* Join Room */}
              <View>
                <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
                  {t('rooms.haveInviteCode')}
                </Text>
                <TextInput
                  value={roomCode}
                  onChangeText={setRoomCode}
                  placeholder={t('rooms.enterCode')}
                  className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-3 tracking-widest text-center"
                  placeholderTextColor="#9ca3af"
                  autoCapitalize="characters"
                  maxLength={12}
                />
                <TouchableOpacity
                  onPress={handleJoinRoom}
                  disabled={!roomCode.trim() || roomCode.trim().length < 6 || isLoading}
                  className="rounded-xl py-3 items-center"
                  style={{
                    backgroundColor:
                      roomCode.trim() && roomCode.trim().length >= 6
                        ? '#213649'
                        : '#d1d5db',
                  }}
                >
                  <Text className="text-white font-semibold text-base">{t('common.join')}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
