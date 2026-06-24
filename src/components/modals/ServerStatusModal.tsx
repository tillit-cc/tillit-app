import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app.store';
import { useServerStore } from '@/stores/server.store';
import { logger } from '@/utils/logger';
import { useAuthStore } from '@/stores/auth.store';
import { serverRegistry } from '@/services/server-registry';
import { discoveryService, DiscoveredServer } from '@/services/discovery.service';
import { SocketConnectionState } from '@/types/connection';
import { Server } from '@/db/schema';
import { DeveloperToolsModal } from './DeveloperToolsModal';
import { isOnionUrl } from '@/services/tor-axios-adapter';

const DIAG_TAP_COUNT = 10;
const DIAG_TAP_WINDOW_MS = 3000;

type HttpStatus = 'connected' | 'token_expired' | 'not_authenticated';
type WsStatus = 'connected' | 'connecting' | 'disconnected';

interface ServerStatusModalProps {
  visible: boolean;
  onClose: () => void;
}

const HTTP_STATUS_CONFIG: Record<HttpStatus, { color: string; labelKey: string }> = {
  connected: { color: '#22c55e', labelKey: 'serverStatus.connected' },
  token_expired: { color: '#eab308', labelKey: 'serverStatus.tokenExpired' },
  not_authenticated: { color: '#ef4444', labelKey: 'serverStatus.notAuthenticated' },
};

const WS_STATUS_CONFIG: Record<WsStatus, { color: string; labelKey: string }> = {
  connected: { color: '#22c55e', labelKey: 'serverStatus.connected' },
  connecting: { color: '#eab308', labelKey: 'serverStatus.connecting' },
  disconnected: { color: '#ef4444', labelKey: 'serverStatus.disconnected' },
};

function mapConnectionState(state: SocketConnectionState | undefined): WsStatus {
  switch (state) {
    case SocketConnectionState.CONNECTED:
      return 'connected';
    case SocketConnectionState.CONNECTING:
      return 'connecting';
    default:
      return 'disconnected';
  }
}

function deriveHttpStatus(isAuthenticated: boolean, isTokenExpired: boolean): HttpStatus {
  if (!isAuthenticated) return 'not_authenticated';
  if (isTokenExpired) return 'token_expired';
  return 'connected';
}

export function ServerStatusModal({ visible, onClose }: ServerStatusModalProps) {
  const dbServers = useServerStore((s) => s.servers);
  const connectionStates = useServerStore((s) => s.connectionStates);
  const reconnectAttemptsMap = useServerStore((s) => s.reconnectAttempts);
  const bannedServers = useServerStore((s) => s.bannedServers);
  const primaryInactiveServers = useServerStore((s) => s.primaryInactiveServers);
  const connectionLog = useAppStore((s) => s.connectionLog);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isTokenExpired = useAuthStore((s) => s.isTokenExpired);
  const { t } = useTranslation();

  const [showDiagLog, setShowDiagLog] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [serverName, setServerName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [reconnectingServerId, setReconnectingServerId] = useState<number | null>(null);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [addingDiscovered, setAddingDiscovered] = useState<string | null>(null);
  const [showDevToolsSection, setShowDevToolsSection] = useState(false);
  const [showDevToolsModal, setShowDevToolsModal] = useState(false);
  const tapTimestamps = useRef<number[]>([]);

  useEffect(() => {
    if (visible) {
      discoveryService.startScan();
      const unsub = discoveryService.onChange(setDiscoveredServers);
      return () => {
        unsub();
        discoveryService.stopScan();
      };
    }
  }, [visible]);

  const handleTitlePress = useCallback(() => {
    const now = Date.now();
    tapTimestamps.current.push(now);
    tapTimestamps.current = tapTimestamps.current.filter(
      (t) => now - t < DIAG_TAP_WINDOW_MS
    );
    if (tapTimestamps.current.length >= DIAG_TAP_COUNT) {
      setShowDiagLog((prev) => !prev);
      if (__DEV__) setShowDevToolsSection((prev) => !prev);
      tapTimestamps.current = [];
    }
  }, []);

  const handleReconnect = useCallback(async (server: Server) => {
    setReconnectingServerId(server.id);
    try {
      await serverRegistry.reconnectServer(server.id);
    } catch (error: any) {
      Alert.alert(t('common.error'), error?.message || t('serverStatus.reconnectFailed'));
    } finally {
      setReconnectingServerId(null);
    }
  }, []);

  const handleAddServer = useCallback(async () => {
    const name = serverName.trim();
    const url = serverUrl.trim();
    if (!name || !url || isLoading) return;

    // .onion URLs: auto-prepend http:// if no schema (Tor encrypts in-circuit, no TLS needed)
    let finalUrl = url;
    if (isOnionUrl(url) && !url.startsWith('http://') && !url.startsWith('https://')) {
      finalUrl = `http://${url}`;
    } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      Alert.alert(t('common.error'), t('serverStatus.urlValidation'));
      return;
    }

    // Show Tor notice for .onion URLs
    if (isOnionUrl(finalUrl)) {
      logger.info('[ServerStatusModal] Adding .onion server — will route via Tor');
    }

    setIsLoading(true);
    try {
      await serverRegistry.addServer(name, finalUrl);

      setServerName('');
      setServerUrl('');
      setShowAddForm(false);
      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      Alert.alert(t('common.error'), error?.message || t('serverStatus.addServerError'));
    }
  }, [serverName, serverUrl, isLoading]);

  const handleRemoveServer = useCallback((server: Server) => {
    if (server.isDefault === 1) {
      Alert.alert(t('common.error'), t('serverStatus.cantRemoveMain'));
      return;
    }

    Alert.alert(
      t('serverStatus.removeServer'),
      t('serverStatus.removeServerMsg', { name: server.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('serverStatus.remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              await serverRegistry.removeServer(server.id);
            } catch (error: any) {
              Alert.alert(t('common.error'), error?.message || t('serverStatus.removeError'));
            }
          },
        },
      ]
    );
  }, []);

  const handleClose = useCallback(() => {
    setShowAddForm(false);
    setServerName('');
    setServerUrl('');
    setIsLoading(false);
    onClose();
  }, [onClose]);

  const handleConnectDiscovered = useCallback(async (ds: DiscoveredServer, url: string) => {
    setAddingDiscovered(ds.name);
    try {
      await serverRegistry.addServer(ds.name, url);
    } catch (error: any) {
      Alert.alert(t('common.error'), error?.message || t('serverStatus.addServerError'));
    } finally {
      setAddingDiscovered(null);
    }
  }, []);

  const newDiscovered = discoveredServers.filter(
    (ds) => {
      const anyAdded = dbServers.some((s) => s.apiUrl === ds.apiUrl)
        || (ds.onionUrl && dbServers.some((s) => s.apiUrl === ds.onionUrl))
        || (ds.lanUrl && dbServers.some((s) => s.apiUrl === ds.lanUrl));
      return !anyAdded;
    }
  );

  const httpStatus = deriveHttpStatus(isAuthenticated, isTokenExpired());

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
          <Pressable onPress={handleTitlePress}>
            <Text className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('serverStatus.servers')}
            </Text>
          </Pressable>
          <TouchableOpacity
            onPress={() => setShowAddForm(!showAddForm)}
            className="p-2"
          >
            <Ionicons
              name={showAddForm ? 'chevron-up' : 'add'}
              size={24}
              color="#2ad1af"
            />
          </TouchableOpacity>
        </View>

        {/* Loading overlay */}
        {isLoading && (
          <View className="absolute inset-0 z-50 items-center justify-center bg-black/40">
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-8 items-center mx-8">
              <ActivityIndicator size="large" color="#2ad1af" />
              <Text className="mt-4 text-base text-gray-600 dark:text-gray-300">
                {t('serverStatus.addingServer')}
              </Text>
            </View>
          </View>
        )}

        {/* Add server form */}
        {showAddForm && (
          <View className="px-6 pt-4 pb-2 border-b border-gray-200 dark:border-gray-700">
            <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
              {t('serverStatus.addServer')}
            </Text>
            <TextInput
              value={serverName}
              onChangeText={setServerName}
              placeholder={t('serverStatus.serverNamePlaceholder')}
              className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-3"
              placeholderTextColor="#9ca3af"
            />
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://api.example.com or xyz.onion"
              className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-3"
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {/* Tor notice for .onion URLs */}
            {isOnionUrl(serverUrl.trim()) && (
              <View className="bg-purple-50 dark:bg-purple-950 rounded-xl px-4 py-3 mb-3 flex-row items-center"
                style={{ borderWidth: 1, borderColor: '#c084fc' }}>
                <Ionicons name="shield-half-outline" size={18} color="#9333ea" style={{ marginRight: 8 }} />
                <Text className="text-xs text-purple-700 dark:text-purple-300 flex-1">
                  {t('serverStatus.torNotice')}
                </Text>
              </View>
            )}
            <TouchableOpacity
              onPress={handleAddServer}
              disabled={!serverName.trim() || !serverUrl.trim() || isLoading}
              className="rounded-xl py-3 items-center mb-3"
              style={{
                backgroundColor:
                  serverName.trim() && serverUrl.trim() ? '#2ad1af' : '#d1d5db',
              }}
            >
              <Text className="text-white font-semibold text-base">{t('serverStatus.addBtn')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          {/* Server list */}
          <View style={{ gap: 12 }}>
            {dbServers.map((server) => {
              const wsState = connectionStates.get(server.id);
              const reconnectAttempts = reconnectAttemptsMap.get(server.id) || 0;
              const wsStatus = mapConnectionState(wsState);
              const httpConfig = HTTP_STATUS_CONFIG[httpStatus];
              const wsConfig = WS_STATUS_CONFIG[wsStatus];
              const isBanned = bannedServers.has(server.id);
              const isPrimaryInactive = primaryInactiveServers.has(server.id);

              return (
                <View
                  key={server.id}
                  className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3"
                >
                  {/* Name + delete */}
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center flex-1">
                      <Text className="text-base font-semibold text-gray-900 dark:text-white">
                        {server.name}
                      </Text>
                      {server.isDefault === 1 && (
                        <View className="ml-2 bg-teal-100 dark:bg-teal-900 rounded px-1.5 py-0.5">
                          <Text className="text-xs text-teal-700 dark:text-teal-300">{t('serverStatus.main')}</Text>
                        </View>
                      )}
                      {isOnionUrl(server.apiUrl) && (
                        <View className="ml-2 bg-purple-100 dark:bg-purple-900 rounded px-1.5 py-0.5 flex-row items-center">
                          <Ionicons name="shield-half-outline" size={10} color="#9333ea" style={{ marginRight: 2 }} />
                          <Text className="text-xs text-purple-700 dark:text-purple-300">Tor</Text>
                        </View>
                      )}
                      {isBanned && (
                        <View className="ml-2 bg-red-100 dark:bg-red-900 rounded px-1.5 py-0.5">
                          <Text className="text-xs text-red-700 dark:text-red-300">{t('report.serverInaccessible')}</Text>
                        </View>
                      )}
                      {!isBanned && isPrimaryInactive && (
                        <View className="ml-2 bg-amber-100 dark:bg-amber-900 rounded px-1.5 py-0.5">
                          <Text className="text-xs text-amber-700 dark:text-amber-300">{t('serverStatus.primaryInactiveBadge')}</Text>
                        </View>
                      )}
                    </View>
                    {server.isDefault !== 1 && (
                      <TouchableOpacity
                        onPress={() => handleRemoveServer(server)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons name="trash-outline" size={20} color="#ef4444" />
                      </TouchableOpacity>
                    )}
                  </View>

                  <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {server.apiUrl}
                  </Text>

                  {/* Status badges */}
                  <View className="flex-row mt-3" style={{ gap: 16 }}>
                    {/* HTTP badge */}
                    <View className="flex-row items-center">
                      <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 mr-1.5">
                        HTTP
                      </Text>
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: httpConfig.color,
                          marginRight: 4,
                        }}
                      />
                      <Text
                        className="text-sm font-medium"
                        style={{ color: httpConfig.color }}
                      >
                        {t(httpConfig.labelKey)}
                      </Text>
                    </View>

                    {/* WS badge */}
                    <View className="flex-row items-center">
                      <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 mr-1.5">
                        WS
                      </Text>
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: wsConfig.color,
                          marginRight: 4,
                        }}
                      />
                      <Text
                        className="text-sm font-medium"
                        style={{ color: wsConfig.color }}
                      >
                        {t(wsConfig.labelKey)}
                      </Text>
                    </View>
                  </View>

                  {reconnectAttempts > 0 && (
                    <Text className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      {t('serverStatus.reconnectAttempts', { count: reconnectAttempts })}
                    </Text>
                  )}

                  {/* Banned message */}
                  {isBanned && (
                    <Text className="text-xs text-red-500 dark:text-red-400 mt-2">
                      {t('report.serverBanned')}
                    </Text>
                  )}

                  {/* ADR-0011 liveness lock — reversible, reconnect the primary */}
                  {!isBanned && isPrimaryInactive && (
                    <Text className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                      {t('serverStatus.primaryInactiveHint')}
                    </Text>
                  )}

                  {/* Reconnect button for disconnected servers (hidden when banned) */}
                  {wsStatus === 'disconnected' && !isBanned && (
                    <TouchableOpacity
                      onPress={() => handleReconnect(server)}
                      disabled={reconnectingServerId === server.id}
                      className="flex-row items-center justify-center mt-3 rounded-lg py-2"
                      style={{ backgroundColor: reconnectingServerId === server.id ? '#9ca3af' : '#2ad1af' }}
                    >
                      {reconnectingServerId === server.id ? (
                        <ActivityIndicator size="small" color="#ffffff" />
                      ) : (
                        <>
                          <Ionicons name="refresh" size={16} color="#ffffff" style={{ marginRight: 6 }} />
                          <Text className="text-white text-sm font-medium">{t('serverStatus.reconnect')}</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>

          {/* Discovered servers via mDNS */}
          {newDiscovered.length > 0 && (
            <View className="mt-4">
              <Text className="text-sm font-medium text-teal-600 dark:text-teal-400 mb-2 uppercase tracking-wide">
                {t('serverStatus.discoveredServers')}
              </Text>
              <View style={{ gap: 10 }}>
                {newDiscovered.map((ds) => {
                  const isAdding = addingDiscovered === ds.name;
                  const apiAdded = dbServers.some((s) => s.apiUrl === ds.apiUrl);
                  const torAdded = ds.onionUrl ? dbServers.some((s) => s.apiUrl === ds.onionUrl) : true;
                  const lanAdded = ds.lanUrl ? dbServers.some((s) => s.apiUrl === ds.lanUrl) : true;
                  const hasMultiple = (!apiAdded ? 1 : 0) + (!torAdded ? 1 : 0) + (!lanAdded ? 1 : 0) > 1;

                  // Build button list: tunnel/apiUrl first, then Tor, then LAN last
                  const buttons: { url: string; label: string; icon: string; color: string; added: boolean }[] = [];
                  if (ds.lanUrl) {
                    // txt.host present — apiUrl is tunnel, lanUrl is separate
                    buttons.push({ url: ds.apiUrl, label: 'HTTPS', icon: 'globe-outline', color: '#2563eb', added: apiAdded });
                  }
                  if (ds.onionUrl) {
                    buttons.push({ url: ds.onionUrl, label: 'Tor', icon: 'shield-half-outline', color: '#9333ea', added: torAdded });
                  }
                  if (ds.lanUrl) {
                    buttons.push({ url: ds.lanUrl, label: 'LAN', icon: 'wifi', color: '#2ad1af', added: lanAdded });
                  }
                  if (!ds.lanUrl && !ds.onionUrl) {
                    // No txt.host, no onion — single connect button
                    buttons.push({ url: ds.apiUrl, label: t('serverStatus.connectBtn'), icon: 'link', color: '#2ad1af', added: apiAdded });
                  }
                  if (!ds.lanUrl && ds.onionUrl) {
                    // No txt.host but onion — apiUrl is LAN
                    buttons.push({ url: ds.apiUrl, label: 'LAN', icon: 'wifi', color: '#2ad1af', added: apiAdded });
                  }

                  const visibleButtons = buttons.filter((b) => !b.added);

                  return (
                    <View
                      key={ds.name}
                      className="bg-teal-50 dark:bg-teal-950 rounded-xl px-4 py-3"
                      style={{ borderWidth: 1, borderColor: '#99f6e4' }}
                    >
                      <View className="flex-row items-center">
                        <Ionicons name="wifi" size={18} color="#14b8a6" style={{ marginRight: 8 }} />
                        <View className="flex-1">
                          <Text className="text-base font-semibold text-gray-900 dark:text-white">
                            {ds.name}
                          </Text>
                          <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" numberOfLines={1}>
                            {ds.apiUrl}
                          </Text>
                          {ds.onionUrl && (
                            <Text className="text-xs text-purple-500 dark:text-purple-400 mt-0.5" numberOfLines={1}>
                              {ds.onionUrl}
                            </Text>
                          )}
                          {ds.lanUrl && (
                            <Text className="text-xs text-gray-400 dark:text-gray-500 mt-0.5" numberOfLines={1}>
                              {ds.lanUrl}
                            </Text>
                          )}
                        </View>
                      </View>
                      {hasMultiple ? (
                        <View className="flex-row mt-3" style={{ gap: 8 }}>
                          {visibleButtons.map((btn) => (
                            <TouchableOpacity
                              key={btn.url}
                              onPress={() => handleConnectDiscovered(ds, btn.url)}
                              disabled={isAdding}
                              className="flex-1 flex-row items-center justify-center rounded-lg py-2"
                              style={{ backgroundColor: isAdding ? '#9ca3af' : btn.color }}
                            >
                              {isAdding ? (
                                <ActivityIndicator size="small" color="#ffffff" />
                              ) : (
                                <>
                                  <Ionicons name={btn.icon as any} size={14} color="#ffffff" style={{ marginRight: 5 }} />
                                  <Text className="text-white text-sm font-medium">{btn.label}</Text>
                                </>
                              )}
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : visibleButtons.length === 1 ? (
                        <TouchableOpacity
                          onPress={() => handleConnectDiscovered(ds, visibleButtons[0].url)}
                          disabled={isAdding}
                          className="flex-row items-center justify-center mt-3 rounded-lg py-2"
                          style={{ backgroundColor: isAdding ? '#9ca3af' : visibleButtons[0].color }}
                        >
                          {isAdding ? (
                            <ActivityIndicator size="small" color="#ffffff" />
                          ) : (
                            <>
                              <Ionicons name={visibleButtons[0].icon as any} size={16} color="#ffffff" style={{ marginRight: 6 }} />
                              <Text className="text-white text-sm font-medium">{visibleButtons[0].label}</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Developer Tools — hidden, tap title 10x to toggle (DEV only) */}
          {showDevToolsSection && (
            <View className="mt-4">
              <Text className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2 uppercase tracking-wide">
                Developer Tools
              </Text>
              <TouchableOpacity
                onPress={() => setShowDevToolsModal(true)}
                className="bg-amber-50 dark:bg-amber-950 rounded-xl px-4 py-3 flex-row items-center"
                style={{ borderWidth: 1, borderColor: '#fbbf24' }}
              >
                <Ionicons name="flask" size={20} color="#d97706" style={{ marginRight: 10 }} />
                <View className="flex-1">
                  <Text className="text-base font-semibold text-gray-900 dark:text-white">
                    Seed Demo Data
                  </Text>
                  <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Populate the app with fake data for performance testing
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
              </TouchableOpacity>
            </View>
          )}

          {/* Diagnostic log — hidden, tap title 10x to toggle */}
          {showDiagLog && connectionLog.length > 0 && (
            <View className="mt-4">
              <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
                {t('serverStatus.diagnosticLog')}
              </Text>
              <ScrollView
                style={{ maxHeight: 200 }}
                className="bg-gray-100 dark:bg-gray-800 rounded-xl p-3"
                nestedScrollEnabled
              >
                {connectionLog.map((entry, i) => (
                  <Text
                    key={i}
                    className="text-xs text-gray-600 dark:text-gray-300"
                    style={{ fontFamily: 'Menlo', fontSize: 10, lineHeight: 16 }}
                  >
                    {entry}
                  </Text>
                ))}
              </ScrollView>
            </View>
          )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* Developer Tools Modal */}
      {__DEV__ && (
        <DeveloperToolsModal
          visible={showDevToolsModal}
          onClose={() => setShowDevToolsModal(false)}
        />
      )}
    </Modal>
  );
}
