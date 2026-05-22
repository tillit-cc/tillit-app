import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Localization from 'expo-localization';
import SignalProtocol from 'signal-protocol';
import { SocketConnectionState } from '@/types/connection';
import { serverRegistry } from './server-registry';
import { chatService } from './chat.service';
import { sessionService } from './session.service';
import { profileRepository } from '@/db/repositories/profile.repository';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { useServerStore } from '@/stores/server.store';
import { logger } from '@/utils/logger';
import { deleteAllImages } from '@/utils/image';
import { useChatStore } from '@/stores/chat.store';
import { messageRepository } from '@/db/repositories/message.repository';
import { healthCheckService } from './health-check.service';
import { torService } from './tor.service';

class AppInitService {
  private initialized = false;
  private appStateSubscription: any = null;
  private unsubscribes: (() => void)[] = [];
  private lastBackground = 0;
  private readonly LOCK_TIMEOUT = 30000; // 30s before requiring re-auth

  /**
   * Full bootstrap after authentication (mirrors Ionic initialize.app.service.ts)
   *
   * Order matters:
   * 0. Load servers from DB + ensure default server exists
   * 1. Recover stuck messages (crash recovery)
   * 2. Load Signal sessions from DB
   * 3. Init chat service (register socket handlers BEFORE socket connects)
   * 4. Load rooms from DB (must be populated BEFORE socket connects for rejoin)
   * 5. Initialize pre-key tracking
   * 6. Load profile from DB
   * 7. Connect all sockets (handlers + rooms already ready)
   * 8. Refresh pre-keys for all servers (non-blocking)
   * 9. Register push token on all servers (non-blocking)
   * 10. Setup lifecycle listeners
   */
  async initialize(): Promise<void> {

    if (this.initialized) {
      logger.info('[AppInit] Already initialized - ensuring socket connections');
      await this.ensureSocketsConnected();
      return;
    }

    logger.info('[AppInit] Starting bootstrap...');

    // --- Step 0a: Initialize encrypted database (mandatory) ---
    logger.info('[AppInit] Step 0a: Initializing encrypted database...');
    const { initDatabase } = require('@/db/client');
    await initDatabase();
    logger.info('[AppInit] Step 0a: OK');

    // --- Step 0a': Cache local deviceId (best-effort) ---
    // Reads `getPublicIdentity().deviceId` and stores it in auth.store so the
    // multi-device send path can skip self when fanning out. Best-effort:
    // if the identity hasn't been unlocked yet (rare, since bootstrap runs
    // post biometric auth) the cache stays null and self-fan-out falls back
    // to the PRIMARY_DEVICE_ID heuristic.
    try {
      await useAuthStore.getState().refreshDeviceId();
    } catch (err) {
      logger.warn('[AppInit] refreshDeviceId failed (non-blocking):', err);
    }

    // Inject auth callbacks into serverRegistry to break the require cycle
    // (serverRegistry must not import auth.store directly)
    serverRegistry.setAuthCallbacks({
      isAuthenticated: () => useAuthStore.getState().isAuthenticated,
      onDefaultServerToken: (token) => useAuthStore.getState().setToken(token),
      getUserId: () => useAuthStore.getState().userId,
    });

    // --- Step 0: Load servers ---
    try {
      logger.info('[AppInit] Step 0: Loading servers...');
      await serverRegistry.loadServers();
      await serverRegistry.ensureDefaultServer();
      logger.info('[AppInit] Step 0: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 0 FAILED: ${error?.message || error}`);
    }

    // --- Critical path: these must succeed ---

    // Step 1: Recover messages stuck in SENDING/PENDING from previous crash
    try {
      logger.info('[AppInit] Step 1: Recovering stuck messages...');
      await chatService.recoverStuckMessages();
      logger.info('[AppInit] Step 1: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 1 FAILED: ${error?.message || error}`);
    }

    // Step 1b: Cleanup expired ephemeral messages
    try {
      await this.cleanupExpiredEphemeralMessages();
    } catch (error: any) {
      logger.info(`[AppInit] Ephemeral cleanup FAILED: ${error?.message || error}`);
    }

    // Step 2: Load all Signal sessions from DB
    try {
      logger.info('[AppInit] Step 2: Loading sessions...');
      await sessionService.loadSessions();
      logger.info('[AppInit] Step 2: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 2 FAILED: ${error?.message || error}`);
    }

    // Step 3: Init chat service (register socket event handlers on all servers)
    // Must happen BEFORE socket.connect() so onConnected() handler is ready
    logger.info('[AppInit] Step 3: Init chat service');
    chatService.init();

    // Step 4: Load rooms from DB
    // Must happen BEFORE socket.connect() so onConnected() can rejoin rooms
    try {
      logger.info('[AppInit] Step 4: Loading rooms...');
      await chatService.loadRooms();
      logger.info('[AppInit] Step 4: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 4 FAILED: ${error?.message || error}`);
    }

    // Step 5: Initialize pre-key ID tracking
    try {
      logger.info('[AppInit] Step 5: Pre-key tracking...');
      await sessionService.initializePreKeyTracking();
      logger.info('[AppInit] Step 5: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 5 FAILED: ${error?.message || error}`);
    }

    // --- Non-critical path: failures logged but don't block bootstrap ---

    // Step 6: Load profile from DB
    try {
      logger.info('[AppInit] Step 6: Loading profile...');
      await this.loadProfile();
      logger.info('[AppInit] Step 6: OK');
    } catch (error: any) {
      logger.info(`[AppInit] Step 6 FAILED: ${error?.message || error}`);
    }

    // Step 7: Connect all sockets (handlers + rooms already ready)
    try {
      logger.info('[AppInit] Step 7: Connecting all sockets...');
      await serverRegistry.connectAll();
      logger.info('[AppInit] Step 7: connectAll() returned');
    } catch (error: any) {
      logger.info(`[AppInit] Step 7 FAILED: ${error?.message || error}`);
    }

    // Step 7b: Health check all servers (non-blocking)
    healthCheckService.checkAll().catch((err) =>
      logger.info(`[AppInit] Health check error: ${err?.message || err}`)
    );

    // Step 8: Refresh pre-keys for all servers (non-blocking)
    sessionService.refreshPreKeysIfNeeded().catch((err) =>
      logger.info(`[AppInit] Pre-key refresh error: ${err?.message || err}`)
    );

    // Step 9: Register push token on all servers (non-blocking)
    this.registerPushTokenOnAllServers().catch((err) =>
      logger.info(`[AppInit] Push registration error: ${err?.message || err}`)
    );

    // Step 10: Setup lifecycle listeners
    this.setupLifecycleListeners();

    // Subscribe to per-server connection state changes + auth errors
    this.cleanupSubscriptions();
    for (const server of serverRegistry.getAllServers()) {
      this.registerServerHandlers(server.id);
    }

    // Register callback for servers added at runtime
    const unsubServerAdded = serverRegistry.onServerAdded((serverId) => {
      this.registerServerHandlers(serverId);
      chatService.registerSocketHandlers(serverId);
    });
    this.unsubscribes.push(unsubServerAdded);

    this.initialized = true;
    logger.info('[AppInit] Bootstrap complete');

    // Step 11: Check for OTA updates (clearnet only — skip if any .onion server exists)
    if (!serverRegistry.hasAnyTorServer()) {
      try {
        const Updates = require('expo-updates');
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          logger.info('[AppInit] OTA update downloaded, will apply on next launch');
        }
      } catch {
        // Non-critical — silently ignore update check failures
      }
    }
  }

  /**
   * Register onStateChange + onAuthError handlers for a server's socket.
   * Called during bootstrap for existing servers, and via onServerAdded for new ones.
   */
  private registerServerHandlers(serverId: number): void {
    const socket = serverRegistry.getSocket(serverId);
    const defaultServerId = serverRegistry.getDefaultServerId();

    const unsubState = socket.onStateChange((state) => {
      useServerStore.getState().setConnectionState(serverId, state);
      logger.info(`[Socket:${serverId}] State -> ${SocketConnectionState[state] || state}`);
    });
    this.unsubscribes.push(unsubState);

    const unsubAuth = socket.onAuthError(() => {
      if (serverId === defaultServerId) {
        if (useServerStore.getState().isBanned(serverId)) {
          logger.info(`[AppInit] Default server ${serverId} is banned — skipping logout`);
          return;
        }
        logger.info(`[AppInit] Auth error from default server ${serverId} — logging out`);
        this.logout();
      } else {
        logger.info(`[AppInit] Auth error from server ${serverId} — attempting re-auth`);
        serverRegistry.reconnectServer(serverId).catch((error) => {
          logger.warn(`[AppInit] Auto re-auth failed for server ${serverId}:`, error);
        });
      }
    });
    this.unsubscribes.push(unsubAuth);
  }

  /**
   * Ensure all sockets are connected.
   * Called when app returns from background or after biometric re-auth.
   * If a server has no token, attempts re-authentication before connecting.
   */
  private async ensureSocketsConnected(): Promise<void> {
    for (const server of serverRegistry.getAllServers()) {
      if (useServerStore.getState().isBanned(server.id)) continue;
      try {
        const socket = serverRegistry.getSocket(server.id);
        if (socket.getConnectionState() === SocketConnectionState.CLOSED) {
          // Check if server has a token — if not, do full re-auth
          const api = serverRegistry.getApi(server.id);
          const token = await api.getToken();
          if (!token) {
            logger.info(`[AppInit] Server ${server.id} has no token — attempting re-auth + connect`);
            await serverRegistry.reconnectServer(server.id);
          } else {
            logger.info(`[AppInit] Socket for server ${server.id} is closed — reconnecting...`);
            await socket.connect();
          }
        }
      } catch (error) {
        logger.warn(`[AppInit] Reconnect error for server ${server.id}:`, error);
      }
    }
  }

  /**
   * Load user profile from DB and set in store
   */
  private async loadProfile(): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) return;

    try {
      const profile = await profileRepository.findByUser(userId);
      if (profile?.username) {
        useAppStore.getState().updateSettings({ username: profile.username });
      }
    } catch (error) {
      logger.warn('[AppInit] Profile load error:', error);
    }
  }

  /**
   * Register push notification token with all servers
   */
  private async registerPushTokenOnAllServers(): Promise<void> {
    try {
      // expo-notifications
      const Notifications = require('expo-notifications');

      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        logger.info('[AppInit] Push permission denied');
        return;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync();
      const token = tokenData.data;
      const lang = Localization.getLocales()[0]?.languageCode ?? 'en';

      for (const server of serverRegistry.getAllServers()) {
        // Skip Tor (.onion) servers — push tokens leak IP via Apple/Google
        const api = serverRegistry.getApi(server.id);
        if (api.useTor) {
          logger.info(`[AppInit] Skipping push registration for Tor server ${server.id}`);
          continue;
        }
        try {
          await api.registerPushToken(token, Platform.OS as 'ios' | 'android', lang);
          logger.info(`[AppInit] Push token registered on server ${server.id}:`, Platform.OS);
        } catch (error) {
          logger.warn(`[AppInit] Push registration failed for server ${server.id}:`, error);
        }
      }
    } catch (error) {
      // expo-notifications might not be installed
      logger.warn('[AppInit] Push registration unavailable:', error);
    }
  }

  /**
   * Setup lifecycle listeners (pause/resume)
   * Mirrors Ionic: lock keychain on background, re-auth on resume
   */
  private setupLifecycleListeners(): void {
    if (this.appStateSubscription) return;

    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
  }

  private handleAppStateChange = async (nextAppState: AppStateStatus) => {
    const appStore = useAppStore.getState();

    if (nextAppState === 'background') {
      // Going to background — disconnect all sockets so the server marks us offline
      // and sends push notifications. Only on 'background', NOT 'inactive':
      // iOS fires 'inactive' during transient UI events (Face ID, system dialogs,
      // notification center) which would cancel in-flight connections.
      this.lastBackground = Date.now();
      appStore.setInBackground(true);

      serverRegistry.disconnectAll();
      logger.info('[AppInit] All sockets disconnected (background)');

      try {
        await SignalProtocol.lock();
        logger.info('[AppInit] Keychain locked');
      } catch (error) {
        logger.warn('[AppInit] Lock error:', error);
      }
    } else if (nextAppState === 'inactive') {
      // Transient state (Face ID prompt, system dialogs, notification center).
      // Track the timestamp so the 'active' branch can decide whether to
      // require re-auth, but DO NOT call `SignalProtocol.lock()` here: iOS
      // raises 'inactive' the moment the biometric UI overlays the app, and
      // invalidating the LAContext mid-prompt produces a second Face ID prompt
      // (and races with the in-flight authenticate() completion).
      this.lastBackground = Date.now();
      appStore.setInBackground(true);
    } else if (nextAppState === 'active') {
      // Coming to foreground
      appStore.setInBackground(false);
      appStore.updateLastActiveTimestamp();

      // Clear notifications from lockscreen/notification center
      try {
        const Notifications = require('expo-notifications');
        await Notifications.dismissAllNotificationsAsync();
        await Notifications.setBadgeCountAsync(0);
      } catch {}

      // Skip network operations if not fully bootstrapped or not authenticated
      if (!this.initialized || !useAuthStore.getState().isAuthenticated) return;

      const elapsed = Date.now() - this.lastBackground;
      if (elapsed > this.LOCK_TIMEOUT) {
        // Require re-authentication — skip all network operations until user re-auths
        try {
          const { authenticated } = SignalProtocol.isAuthenticated();
          if (!authenticated) {
            useAuthStore.getState().setBiometricAuthenticated(false);
            return;
          }
        } catch (error) {
          logger.warn('[AppInit] Auth check error:', error);
          useAuthStore.getState().setBiometricAuthenticated(false);
          return;
        }
      }

      // Skip network operations if biometric re-auth is pending
      if (!useAuthStore.getState().isBiometricAuthenticated) return;

      // Ensure Tor is ready before reconnecting .onion sockets
      // (Arti stays running in background — this is a no-op if already connected)
      if (serverRegistry.hasAnyTorServer()) {
        try {
          await torService.ensureStarted();
        } catch (err) {
          logger.warn('[AppInit] Tor ensure on resume error:', err);
        }
      }

      // Health check all servers (non-blocking)
      healthCheckService.checkAll().catch((err) =>
        logger.warn('[AppInit] Health check on resume error:', err)
      );

      // Reconnect all sockets if needed
      await this.ensureSocketsConnected();

      // Refresh pre-keys regardless of socket state
      // (socket staying connected during background won't trigger onConnected)
      sessionService.refreshPreKeysIfNeeded().catch((err) =>
        logger.warn('[AppInit] Pre-key refresh on resume error:', err)
      );
    }
  };

  /**
   * Cleanup expired ephemeral messages at boot.
   * Updates body to expired placeholder so no media data remains.
   */
  private async cleanupExpiredEphemeralMessages(): Promise<void> {
    try {
      const expired = await messageRepository.findExpiredEphemeral();
      let cleaned = 0;

      for (const msg of expired) {
        try {
          const body = JSON.parse(msg.body);
          // Skip if already cleaned
          if (body.expired) continue;

          const expiredBody = JSON.stringify({
            expired: true,
            viewDuration: body.viewDuration || 0,
          });
          await messageRepository.updateBody(msg.id, expiredBody);
          cleaned++;
        } catch {
          // Body parse failed — already cleaned or corrupted
        }
      }

      if (cleaned > 0) {
        logger.info(`[AppInit] Cleaned ${cleaned} expired ephemeral messages`);
      }
    } catch (error) {
      logger.warn('[AppInit] cleanupExpiredEphemeralMessages error:', error);
    }
  }

  /**
   * Clear all identity data from DB (mirrors Ionic clearAllIdentityData)
   */
  async clearAllIdentityData(): Promise<void> {
    logger.info('[AppInit] Clearing all identity data...');

    const { getSqliteDatabase } = require('@/db/client');
    const db = getSqliteDatabase();

    const tables = [
      'identity',
      'session',
      'sender_key_session',
      'sender_key_retry_queue',
      'message',
      'room',
      'profile',
    ];

    for (const table of tables) {
      try {
        db.execSync(`DELETE FROM ${table}`);
      } catch (error) {
        logger.warn(`[AppInit] Error clearing table ${table}:`, error);
      }
    }

    // Delete all image files from filesystem
    try {
      deleteAllImages();
    } catch (error) {
      logger.warn('[AppInit] Error deleting image files:', error);
    }

    logger.info('[AppInit] All identity data cleared');
  }

  /**
   * Logout: disconnect all sockets and clear tokens.
   * Identity and data are preserved - user can clear them from login page.
   */
  async logout(): Promise<void> {
    logger.info('[AppInit] Logging out (preserving identity and data)...');

    // Disconnect all sockets, clear handlers, and clear instances
    chatService.destroy();
    serverRegistry.clearAll();

    // Clear API tokens for all servers
    for (const server of serverRegistry.getAllServers()) {
      try {
        const api = serverRegistry.getApi(server.id);
        await api.clearToken();
      } catch {
        // Server instances already cleared by clearAll(), token cleanup best-effort
      }
    }

    // Clear token for the default server via SecureStore directly
    try {
      const SecureStore = require('expo-secure-store');
      // Clear all known token keys
      const { serverRepository } = require('@/db/repositories/server.repository');
      const servers = await serverRepository.findAll();
      for (const server of servers) {
        await SecureStore.deleteItemAsync(`token_server_${server.id}`);
      }
    } catch (error) {
      logger.warn('[AppInit] Token cleanup error:', error);
    }

    // Reset stores (in-memory only, DB data preserved)
    useChatStore.getState().clearAll();
    useAuthStore.getState().logout();

    // Remove listeners
    this.cleanupSubscriptions();
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    this.initialized = false;
    logger.info('[AppInit] Logout complete');
  }

  /**
   * Delete account on every registered server, then wipe all local data.
   *
   * Server-side cleanup is best-effort per server: failures are logged and
   * collected but never abort the local wipe — the user's intent to reset
   * the identity is absolute. Orphan records on failed servers are an
   * accepted trade-off (the local keys are destroyed anyway, so those
   * records become unreachable).
   *
   * Returns the list of server IDs that failed to acknowledge deletion, so
   * the UI can surface a non-blocking warning.
   */
  async deleteAccount(): Promise<{ failedServers: number[] }> {
    logger.info('[AppInit] Deleting account on all servers + wiping local data...');

    const failedServers: number[] = [];

    // Phase 1: server-side deletion (best-effort, per server)
    for (const server of serverRegistry.getAllServers()) {
      try {
        const api = serverRegistry.getApi(server.id);
        const token = await api.getToken();
        if (!token) {
          logger.info(`[AppInit] Server ${server.id} has no token — skipping remote delete`);
          continue;
        }
        await api.deleteAccount();
        logger.info(`[AppInit] Account deleted on server ${server.id}`);
      } catch (error: any) {
        const status = error?.response?.status;
        logger.warn(`[AppInit] deleteAccount failed on server ${server.id} (status=${status}):`, error?.message || error);
        failedServers.push(server.id);
      }
    }

    // Phase 2: disconnect everything and clear in-memory state
    chatService.destroy();
    serverRegistry.clearAll();

    // Phase 3: clear native Signal Protocol identity (Keychain / Keystore)
    try {
      await SignalProtocol.clearIdentity();
      logger.info('[AppInit] Signal identity cleared from native keystore');
    } catch (error) {
      logger.warn('[AppInit] clearIdentity error (continuing):', error);
    }

    // Phase 4: clear all tokens from SecureStore
    try {
      const SecureStore = require('expo-secure-store');
      const { serverRepository } = require('@/db/repositories/server.repository');
      const servers = await serverRepository.findAll();
      for (const server of servers) {
        await SecureStore.deleteItemAsync(`token_server_${server.id}`);
      }
      // Wipe the persisted userId reference too
      await SecureStore.deleteItemAsync('signal_user_id');
    } catch (error) {
      logger.warn('[AppInit] Token/userId cleanup error:', error);
    }

    // Phase 5: clear all SQLite tables + image files
    try {
      await this.clearAllIdentityData();
    } catch (error) {
      logger.warn('[AppInit] clearAllIdentityData error:', error);
    }

    // Phase 6: reset Zustand stores
    useChatStore.getState().clearAll();
    useAuthStore.getState().logout();

    // Phase 7: teardown listeners
    this.cleanupSubscriptions();
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    this.initialized = false;
    logger.info(`[AppInit] Account deletion complete (failedServers=${failedServers.length})`);

    return { failedServers };
  }

  /**
   * Teardown (app closing)
   */
  destroy(): void {
    chatService.destroy();
    serverRegistry.clearAll();

    this.cleanupSubscriptions();
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    this.initialized = false;
  }

  private cleanupSubscriptions(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

export const appInitService = new AppInitService();
