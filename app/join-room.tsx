import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app.store';
import { useAuthStore } from '@/stores/auth.store';
import { useServerStore } from '@/stores/server.store';
import { SocketConnectionState } from '@/types/connection';
import { chatService } from '@/services/chat.service';
import { appInitService } from '@/services/app-init.service';
import { serverRegistry } from '@/services/server-registry';
import { logger } from '@/utils/logger';

export default function JoinRoomScreen() {
  const router = useRouter();
  const pendingInviteCode = useAppStore((s) => s.pendingInviteCode);
  const setPendingInviteCode = useAppStore((s) => s.setPendingInviteCode);
  const storedUsername = useAppStore((s) => s.settings.username);
  const isBiometricAuthenticated = useAuthStore((s) => s.isBiometricAuthenticated);

  const servers = useServerStore((s) => s.servers);
  const connectionStates = useServerStore((s) => s.connectionStates);
  const bannedServers = useServerStore((s) => s.bannedServers);

  const availableServers = servers.filter((s) => !bannedServers.has(s.id));
  const showServerSelector = availableServers.length > 1;

  const [isInitializing, setIsInitializing] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [username, setUsername] = useState(storedUsername || '');
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const selectedServerState = selectedServerId != null
    ? (connectionStates.get(selectedServerId) ?? SocketConnectionState.CLOSED)
    : SocketConnectionState.CLOSED;
  const isSelectedServerConnected = selectedServerState === SocketConnectionState.CONNECTED;

  // No invite code — go back to tabs
  useEffect(() => {
    if (!pendingInviteCode) {
      router.replace('/(tabs)');
    }
  }, [pendingInviteCode, router]);

  // Bootstrap app (idempotent)
  useEffect(() => {
    if (!isBiometricAuthenticated || !pendingInviteCode) return;

    let cancelled = false;
    appInitService
      .initialize()
      .catch((err) => logger.error('[JoinRoom] Bootstrap failed:', err))
      .finally(() => {
        if (cancelled) return;
        try {
          const defaultId = serverRegistry.getDefaultServerId();
          const banned = useServerStore.getState().bannedServers;
          if (!banned.has(defaultId)) {
            setSelectedServerId(defaultId);
          } else {
            const avail = useServerStore.getState().servers.filter((s) => !banned.has(s.id));
            if (avail.length > 0) setSelectedServerId(avail[0].id);
          }
        } catch {
          const banned = useServerStore.getState().bannedServers;
          const avail = useServerStore.getState().servers.filter((s) => !banned.has(s.id));
          if (avail.length > 0) setSelectedServerId(avail[0].id);
        }
        setIsInitializing(false);
      });

    return () => { cancelled = true; };
  }, [isBiometricAuthenticated, pendingInviteCode]);

  // Auto-join when username is already set, init is done, and server is connected
  // Skip auto-join when multiple servers exist — user must choose which server
  useEffect(() => {
    if (!isInitializing && storedUsername && pendingInviteCode && !isJoining && !error && !showServerSelector && isSelectedServerConnected) {
      handleJoin(storedUsername);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitializing, isSelectedServerConnected]);

  const handleJoin = useCallback(async (name: string) => {
    if (!pendingInviteCode || isJoining) return;

    setIsJoining(true);
    setError(null);

    try {
      const roomId = await chatService.joinRoom(pendingInviteCode, name.trim(), selectedServerId ?? undefined);
      setPendingInviteCode(null);
      // Replace join-room with tabs (ensures tabs is the root), then push chat on top.
      // This gives a clean stack: /(tabs) → /chat/[id], so back always works.
      router.replace('/(tabs)');
      router.push(`/chat/${roomId}`);
    } catch (err: any) {
      logger.error('[JoinRoom] Join failed:', err);
      setError(err?.message || t('rooms.joinError'));
      setIsJoining(false);
    }
  }, [pendingInviteCode, isJoining, setPendingInviteCode, router, selectedServerId]);

  const handleCancel = useCallback(() => {
    setPendingInviteCode(null);
    router.replace('/(tabs)');
  }, [setPendingInviteCode, router]);

  const handleSubmit = useCallback(() => {
    if (!username.trim()) {
      Alert.alert(t('common.warning'), t('rooms.enterNameWarning'));
      return;
    }
    handleJoin(username.trim());
  }, [username, handleJoin]);

  // Loading: bootstrap in progress
  if (isInitializing) {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900 items-center justify-center">
        <ActivityIndicator size="large" color="#2ad1af" />
        <Text className="mt-4 text-gray-500 dark:text-gray-400">
          {t('rooms.preparing')}
        </Text>
      </SafeAreaView>
    );
  }

  // Auto-join in progress (username already set)
  if (isJoining && !error) {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900 items-center justify-center">
        <ActivityIndicator size="large" color="#2ad1af" />
        <Text className="mt-4 text-base text-gray-700 dark:text-gray-300 font-medium">
          {t('rooms.connectingRoom')}
        </Text>
      </SafeAreaView>
    );
  }

  // Error state
  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900 items-center justify-center px-8">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="mt-4 text-base text-gray-700 dark:text-gray-300 text-center">
          {error}
        </Text>
        <TouchableOpacity
          onPress={handleCancel}
          className="mt-6 px-6 py-3 rounded-full"
          style={{ backgroundColor: '#2ad1af' }}
        >
          <Text className="text-white font-semibold">{t('common.close')}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Input form (username and/or server selection)
  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-900">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        {/* Header */}
        <View className="flex-row items-center px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <TouchableOpacity onPress={handleCancel} className="p-2">
            <Ionicons name="close" size={24} color="#5d7da3" />
          </TouchableOpacity>
          <Text className="flex-1 text-center text-lg font-semibold text-gray-900 dark:text-white">
            {t('rooms.joinRoom')}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        <View className="flex-1 px-6 pt-8">
          {/* Invite code display */}
          <View className="items-center mb-8">
            <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              {t('rooms.inviteCode')}
            </Text>
            <Text className="text-2xl font-bold tracking-widest" style={{ color: '#2ad1af' }}>
              {pendingInviteCode}
            </Text>
          </View>

          {/* Server selector (only when >1 server) */}
          {showServerSelector && (
            <View className="mb-6">
              <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
                {t('rooms.server')}
              </Text>
              <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                {availableServers.map((server) => {
                  const isSelected = selectedServerId === server.id;
                  const state = connectionStates.get(server.id) ?? SocketConnectionState.CLOSED;
                  const dotColor = state === SocketConnectionState.CONNECTED
                    ? '#22c55e'
                    : state === SocketConnectionState.CONNECTING
                      ? '#eab308'
                      : '#ef4444';
                  return (
                    <TouchableOpacity
                      key={server.id}
                      onPress={() => setSelectedServerId(server.id)}
                      className={`flex-row items-center rounded-xl px-4 py-2 border ${
                        isSelected
                          ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/30'
                          : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800'
                      }`}
                    >
                      <View
                        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, marginRight: 6 }}
                      />
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

          {/* Username input */}
          <View className="mb-6">
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
              autoFocus={!storedUsername}
              returnKeyType="go"
              onSubmitEditing={handleSubmit}
            />
          </View>

          {/* Join button */}
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!username.trim() || isJoining || !isSelectedServerConnected}
            className="rounded-xl py-3 items-center mb-3"
            style={{
              backgroundColor: username.trim() && isSelectedServerConnected ? '#2ad1af' : '#d1d5db',
            }}
          >
            <Text className="text-white font-semibold text-base">
              {isSelectedServerConnected ? t('common.join') : t('rooms.waitingConnection')}
            </Text>
          </TouchableOpacity>

          {/* Cancel button */}
          <TouchableOpacity
            onPress={handleCancel}
            className="rounded-xl py-3 items-center"
          >
            <Text className="text-gray-500 dark:text-gray-400 text-base">{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
