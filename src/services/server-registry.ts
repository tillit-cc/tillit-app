import { ApiService } from './api.service';
import { SocketService } from './socket.service';
import { serverRepository } from '@/db/repositories/server.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { useServerStore } from '@/stores/server.store';
import { useChatStore } from '@/stores/chat.store';
import { getServerIdFromRoomId } from '@/utils/server-id';
import { Server } from '@/db/schema';
import { logger } from '@/utils/logger';
import { torService } from './tor.service';
import { isOnionUrl } from './tor-axios-adapter';
import { buildChallengeMessageBase64 } from '@/utils/challenge';
import { isDeviceAuthMismatchError } from '@/utils/auth-errors';
import { diagnostics } from './diagnostics.service';
import * as SecureStore from 'expo-secure-store';

export class ServerRegistry {
  private apis = new Map<number, ApiService>();
  private sockets = new Map<number, SocketService>();
  private serverMap = new Map<number, Server>();
  private reauthInProgress = new Set<number>();
  private serverAddedCallbacks: ((serverId: number) => void)[] = [];
  // Coalesces concurrent keystore unlocks so parallel server auths
  // (connectAll) never stack multiple biometric prompts. See ensureKeystoreUnlocked.
  private unlockInFlight: Promise<void> | null = null;

  /**
   * Injected callbacks to break the require cycle with auth.store.
   * Set by app-init.service during bootstrap.
   */
  /**
   * Injected callbacks to break the require cycle with auth.store.
   * Set by app-init.service during bootstrap.
   */
  private authCheckerFn: (() => boolean) | null = null;
  private onDefaultServerTokenFn: ((token: string) => void) | null = null;
  private userIdGetterFn: (() => number | null) | null = null;

  /**
   * Inject auth-related callbacks from outside (called by AppInitService).
   * This avoids a direct import of auth.store → no require cycle.
   */
  setAuthCallbacks(callbacks: {
    isAuthenticated: () => boolean;
    onDefaultServerToken: (token: string) => void;
    getUserId: () => number | null;
  }): void {
    this.authCheckerFn = callbacks.isAuthenticated;
    this.onDefaultServerTokenFn = callbacks.onDefaultServerToken;
    this.userIdGetterFn = callbacks.getUserId;
  }

  // ========================================
  // BOOTSTRAP
  // ========================================

  /**
   * Load servers from DB and create service instances.
   */
  async loadServers(): Promise<void> {
    const dbServers = await serverRepository.findAll();

    // Sync default server URLs with env vars (they may change across app updates)
    const defaultServer = dbServers.find((s) => s.isDefault === 1);
    if (defaultServer) {
      await this.syncDefaultServerFromEnv(defaultServer, dbServers);
    }

    for (const server of dbServers) {
      this.serverMap.set(server.id, server);
      this.createInstances(server);
    }

    // Always sync default server userId from SecureStore.
    // After re-login the server assigns a new userId but the DB still has the old one.
    if (defaultServer) {
      try {
        const storedUserId = await SecureStore.getItemAsync('signal_user_id');
        if (storedUserId) {
          const uid = parseInt(storedUserId, 10);
          if (defaultServer.userId !== uid) {
            logger.info(`[ServerRegistry] Default server userId updated: ${defaultServer.userId} → ${uid}`);
          }
          defaultServer.userId = uid;
          await serverRepository.update(defaultServer.id, { userId: uid });
        }
      } catch (error) {
        logger.warn('[ServerRegistry] Default server userId sync error:', error);
      }
    }

    // Migrate token from temporary key (token_server_0) if a default server
    // with a different id exists. This happens when login ran before serverRegistry
    // was loaded and saved the token under serverId=0.
    // Always overwrite: after re-login the temp token is the newest and must
    // replace any stale token left from a previous session.
    if (defaultServer && defaultServer.id !== 0) {
      try {
        const tempToken = await SecureStore.getItemAsync('token_server_0');
        if (tempToken) {
          const realKey = `token_server_${defaultServer.id}`;
          await SecureStore.setItemAsync(realKey, tempToken);
          logger.info('[ServerRegistry] Migrated token from token_server_0 to ' + realKey);
          await SecureStore.deleteItemAsync('token_server_0');
        }
      } catch (error) {
        logger.warn('[ServerRegistry] Token migration in loadServers error:', error);
      }
    }

    useServerStore.getState().setServers(dbServers);
    logger.info(`[ServerRegistry] Loaded ${dbServers.length} servers`);
  }

  /**
   * Ensure the default server (id=0 concept mapped to first DB row) exists.
   * Creates it from env vars if missing.
   */
  async ensureDefaultServer(): Promise<void> {
    const existing = await serverRepository.findDefault();
    if (existing) {
      // Already loaded via loadServers
      return;
    }

    const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'https://api.tillit.cc';
    const socketUrl = process.env.EXPO_PUBLIC_SOCKET_URL || apiUrl;
    const namespace = process.env.EXPO_PUBLIC_SOCKET_NAMESPACE || '/chat';

    const server = await serverRepository.create({
      name: 'TilliT Cloud',
      apiUrl,
      socketUrl,
      socketNamespace: namespace,
      isDefault: 1,
      status: 1,
    });

    this.serverMap.set(server.id, server);
    this.createInstances(server);
    useServerStore.getState().addServer(server);

    // Migrate token from temporary key (token_server_0) used during login
    // before serverRegistry was loaded. The real server gets an auto-increment id.
    // Always overwrite to ensure the latest token from re-login is used.
    if (server.id !== 0) {
      try {
        const tempToken = await SecureStore.getItemAsync('token_server_0');
        if (tempToken) {
          await SecureStore.setItemAsync(`token_server_${server.id}`, tempToken);
          await SecureStore.deleteItemAsync('token_server_0');
          logger.info('[ServerRegistry] Migrated token from token_server_0 to token_server_' + server.id);
        }
      } catch (error) {
        logger.warn('[ServerRegistry] Token migration error:', error);
      }
    }

    logger.info('[ServerRegistry] Default server created, id:', server.id);
  }

  // ========================================
  // LOOKUP
  // ========================================

  getApi(serverId: number): ApiService {
    const api = this.apis.get(serverId);
    if (!api) throw new Error(`ApiService not found for server ${serverId}`);
    return api;
  }

  getSocket(serverId: number): SocketService {
    const socket = this.sockets.get(serverId);
    if (!socket) throw new Error(`SocketService not found for server ${serverId}`);
    return socket;
  }

  /**
   * Get ApiService for a room by deducing serverId from the local room ID.
   * For default server (serverId=0 from room ID offset), maps to the actual
   * default server DB id.
   */
  getApiForRoom(localRoomId: number): ApiService {
    const serverId = this.resolveServerId(localRoomId);
    return this.getApi(serverId);
  }

  getSocketForRoom(localRoomId: number): SocketService {
    const serverId = this.resolveServerId(localRoomId);
    return this.getSocket(serverId);
  }

  getServer(serverId: number): Server | undefined {
    return this.serverMap.get(serverId);
  }

  getAllServers(): Server[] {
    return Array.from(this.serverMap.values());
  }

  getDefaultServer(): Server | undefined {
    for (const server of this.serverMap.values()) {
      if (server.isDefault === 1) return server;
    }
    return undefined;
  }

  getDefaultServerId(): number {
    const def = this.getDefaultServer();
    if (!def) throw new Error('No default server');
    return def.id;
  }

  /**
   * Get the server-specific user ID for a given server.
   * Each server assigns its own user ID during authentication.
   * Falls back to the global userId from auth store if not set.
   */
  getUserIdForServer(serverId: number): number | null {
    const server = this.serverMap.get(serverId);
    if (server?.userId) return server.userId;
    // Fallback: default server uses the global userId (injected callback)
    return this.userIdGetterFn?.() ?? null;
  }

  /**
   * Get the server-specific user ID for a room (by deducing serverId from room ID).
   */
  getUserIdForRoom(localRoomId: number): number | null {
    const serverId = this.resolveServerId(localRoomId);
    return this.getUserIdForServer(serverId);
  }

  // ========================================
  // EVENTS
  // ========================================

  /**
   * Register a callback invoked when a new server is added at runtime.
   * Used by AppInitService to register socket handlers, state listeners, etc.
   */
  onServerAdded(callback: (serverId: number) => void): () => void {
    this.serverAddedCallbacks.push(callback);
    return () => {
      this.serverAddedCallbacks = this.serverAddedCallbacks.filter((cb) => cb !== callback);
    };
  }

  // ========================================
  // CONNECTIONS
  // ========================================

  async connectAll(): Promise<void> {
    // Start Tor if any .onion servers are configured
    if (this.hasAnyTorServer()) {
      try {
        await torService.ensureStarted();
      } catch (error: any) {
        logger.warn(`[ServerRegistry] Tor start failed: ${error?.message || error}`);
        // Continue — clearnet servers will still connect
      }
    }

    const promises: Promise<void>[] = [];
    for (const [serverId, socket] of this.sockets) {
      promises.push(
        (async () => {
          // Skip servers already marked as banned
          if (useServerStore.getState().isBanned(serverId)) {
            logger.info(`[ServerRegistry] Server ${serverId} is banned — skipping connect`);
            return;
          }

          // Check if we have a token for this server
          const api = this.apis.get(serverId);
          if (api) {
            const token = await api.getToken();
            if (!token) {
              // No token — try auto-authenticate before connecting
              logger.info(`[ServerRegistry] No token for server ${serverId}, attempting auto-auth`);
              try {
                await this.authenticateServer(serverId);
                logger.info(`[ServerRegistry] Auto-auth succeeded for server ${serverId}`);
              } catch (error: any) {
                if (error?.response?.status === 401 && error?.response?.data?.error === 'BANNED') {
                  useServerStore.getState().setBanned(serverId, true);
                  logger.warn(`[ServerRegistry] Server ${serverId} is banned — skipping connect`);
                } else {
                  logger.warn(`[ServerRegistry] Auto-auth failed for server ${serverId}:`, error);
                }
                return; // Skip socket connect — no valid token
              }
            }
          }
          // Re-check ban status: authenticateServer may have flagged it
          if (useServerStore.getState().isBanned(serverId)) {
            logger.info(`[ServerRegistry] Server ${serverId} banned after auth — skipping socket`);
            return;
          }
          await socket.connect();
        })().catch((error) => {
          logger.warn(`[ServerRegistry] Connect failed for server ${serverId}:`, error);
        })
      );
    }
    await Promise.all(promises);
  }

  disconnectAll(): void {
    for (const socket of this.sockets.values()) {
      socket.disconnect();
    }
  }

  /**
   * Re-authenticate a server and reconnect its socket.
   * Used when a server's token is missing or expired.
   * Guards against concurrent re-auth attempts on the same server.
   */
  async reconnectServer(serverId: number): Promise<void> {
    if (this.reauthInProgress.has(serverId)) {
      logger.info(`[ServerRegistry] Re-auth already in progress for server ${serverId}`);
      return;
    }

    const server = this.serverMap.get(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);

    this.reauthInProgress.add(serverId);
    try {
      // Disconnect existing socket
      const socket = this.sockets.get(serverId);
      if (socket) {
        socket.disconnect();
      }

      // Re-authenticate (challenge-response)
      await this.authenticateServer(serverId);
      logger.info(`[ServerRegistry] Re-auth succeeded for server ${serverId}`);

      // Re-upload pre-keys (non-fatal)
      try {
        await this.uploadPreKeysToServer(serverId);
      } catch (error) {
        // ADR-0010 diagnostics: a 409 here means this device tried to register
        // a device-auth key that differs from the one the server already has
        // bound for it (stale/regenerated key). Surfaced distinctly; the cure
        // is the primary-recovery flow (see _shared/questions.md).
        if (isDeviceAuthMismatchError(error)) {
          logger.warn(`[ServerRegistry] DEVICE_AUTH_MISMATCH on /keys for server ${serverId} — device-auth key differs from server-bound key`);
        } else {
          logger.warn(`[ServerRegistry] Pre-key upload failed for server ${serverId} during reconnect:`, error);
        }
      }

      // Reconnect socket (now that we have a valid token)
      if (socket) {
        await socket.connect();
      }
    } finally {
      this.reauthInProgress.delete(serverId);
    }
  }

  // ========================================
  // SERVER MANAGEMENT
  // ========================================

  /**
   * Add a new server: save to DB, authenticate, create instances, connect.
   */
  async addServer(name: string, apiUrl: string, socketUrl?: string, socketNamespace?: string): Promise<Server> {
    const finalSocketUrl = socketUrl || apiUrl;
    const finalNamespace = socketNamespace || '/chat';
    const isTorServer = isOnionUrl(apiUrl) || isOnionUrl(finalSocketUrl);

    // If this is a .onion server, ensure Tor is running before anything else
    if (isTorServer) {
      logger.info('[ServerRegistry] .onion server detected — starting Tor...');
      await torService.ensureStarted();
    }

    // 1. Save server to DB
    const server = await serverRepository.create({
      name,
      apiUrl,
      socketUrl: finalSocketUrl,
      socketNamespace: finalNamespace,
      isDefault: 0,
      isTor: isTorServer ? 1 : 0,
      status: 1,
    });

    this.serverMap.set(server.id, server);
    this.createInstances(server);
    useServerStore.getState().addServer(server);

    logger.info('[ServerRegistry] Server added:', server.id, name);

    // 2. Authenticate with new server (challenge-response using same identity key)
    try {
      logger.info(`[ServerRegistry] Authenticating with server ${server.id} at ${apiUrl}...`);
      await this.authenticateServer(server.id);
      logger.info(`[ServerRegistry] Authenticated with server ${server.id}`);
    } catch (error: any) {
      const errorDetails = {
        message: error?.message,
        code: error?.code,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        isAxiosError: error?.isAxiosError,
        config: error?.config ? {
          url: error.config.url,
          baseURL: error.config.baseURL,
          method: error.config.method,
        } : undefined,
      };
      logger.error(`[ServerRegistry] Auth failed for server ${server.id}:`, JSON.stringify(errorDetails));
      // Cleanup: remove server if auth fails
      await this.removeServer(server.id);

      // Provide more specific error message
      if (error?.message?.includes('Network Error')) {
        throw new Error(`Errore di rete: impossibile raggiungere ${apiUrl}. Su iOS le connessioni HTTP non sicure potrebbero essere bloccate.`);
      }
      throw new Error('Autenticazione con il server fallita: ' + (error?.message || 'errore sconosciuto'));
    }

    // 3. Upload pre-keys to new server
    try {
      await this.uploadPreKeysToServer(server.id);
      logger.info(`[ServerRegistry] Pre-keys uploaded to server ${server.id}`);
    } catch (error) {
      logger.warn(`[ServerRegistry] Pre-key upload failed for server ${server.id}:`, error);
      // Non-fatal: pre-keys can be uploaded later
    }

    // 4. Notify listeners (must happen BEFORE socket.connect so state handlers catch the transition)
    this.serverAddedCallbacks.forEach((cb) => cb(server.id));

    // 5. Connect socket (now that we have a token and handlers are registered)
    try {
      const socket = this.getSocket(server.id);
      await socket.connect();
    } catch (error) {
      logger.warn(`[ServerRegistry] Socket connect failed for server ${server.id}:`, error);
    }

    return server;
  }

  /**
   * Authenticate with a server using challenge-response (same identity key).
   */
  private async authenticateServer(serverId: number): Promise<void> {
    const startedAt = Date.now();
    diagnostics.event('auth', 'authenticate.start', { serverId });
    try {
      await this.authenticateServerInner(serverId);
      diagnostics.event('auth', 'authenticate.ok', {
        serverId,
        durMs: Date.now() - startedAt,
      });
    } catch (error: any) {
      diagnostics.error('auth', 'authenticate.fail', {
        serverId,
        durMs: Date.now() - startedAt,
        errName: error?.name ?? null,
        errMsg: error?.message ?? null,
        httpStatus: error?.response?.status ?? null,
        serverError: error?.response?.data?.error ?? null,
      });
      throw error;
    }
  }

  private async authenticateServerInner(serverId: number): Promise<void> {
    const SignalProtocol = require('signal-protocol').default;
    const api = this.getApi(serverId);

    const publicIdentity = await SignalProtocol.getPublicIdentity();
    const signedPreKeyInfo = await SignalProtocol.getSignedPreKeyInfo();

    // Challenge
    const challengeResponse = await api.requestChallenge(publicIdentity.identityPublicKey);
    if (!challengeResponse?.challengeId || !challengeResponse?.nonce) {
      throw new Error('Invalid challenge response');
    }

    // ADR-0010: signWithDeviceAuth (below) reads the device-auth key from
    // protected storage, which requires an active keystore unlock window.
    // signWithIdentityKey works off the in-memory localUser even when the
    // window is closed, but signWithDeviceAuth would throw "Must call
    // authenticate() first". Multi-server paths (addServer, reconnect,
    // auto-auth on connect) can reach here after the window lapsed — e.g.
    // while Tor bootstraps. Re-open it before signing.
    await this.ensureKeystoreUnlocked();

    // Sign with domain-separated message — see src/utils/challenge.ts
    const challengeMessage = buildChallengeMessageBase64(challengeResponse.nonce, api.baseUrl);
    const { signature } = await SignalProtocol.signWithIdentityKey(challengeMessage);
    // ADR-0010: per-device server-auth signature over the same challenge.
    const { signature: deviceAuthSignature } =
      await SignalProtocol.signWithDeviceAuth(challengeMessage);

    // Authenticate
    const response = await api.authenticateWithIdentity({
      identityPublicKey: publicIdentity.identityPublicKey,
      registrationId: publicIdentity.registrationId,
      deviceId: publicIdentity.deviceId,
      signedPreKeyPublicKey: signedPreKeyInfo.publicKey,
      signedPreKeyId: signedPreKeyInfo.id,
      signedPreKeySignature: signedPreKeyInfo.signature,
      challengeId: challengeResponse.challengeId,
      challengeSignature: signature,
      deviceAuthSignature,
    });

    if (!response?.accessToken) {
      throw new Error('No access token received');
    }

    await api.setToken(response.accessToken);

    // Sync token to auth store for the default server so UI reflects the new state
    // (isTokenExpired reads tokenPayload from auth store, not from ApiService)
    const defaultServer = this.getDefaultServer();
    if (defaultServer && serverId === defaultServer.id) {
      this.onDefaultServerTokenFn?.(response.accessToken);
    }

    // Mark server as banned if flagged in auth response
    if (response.banned) {
      logger.warn(`[ServerRegistry] Server ${serverId} flagged user as banned`);
      useServerStore.getState().setBanned(serverId, true);
    }

    // Store server-specific user ID
    if (response.userId) {
      const server = this.serverMap.get(serverId);
      if (server) {
        this.serverMap.set(serverId, { ...server, userId: response.userId });
      }
      await serverRepository.update(serverId, { userId: response.userId });
      useServerStore.getState().updateServer(serverId, { userId: response.userId });
      logger.info(`[ServerRegistry] Server ${serverId} userId: ${response.userId}`);
    }
  }

  /**
   * Ensure an active keystore unlock window before signing the server-auth
   * challenge.
   *
   * The device-auth key (ADR-0010) lives in protected storage and is only
   * readable while the keystore is unlocked; `signWithDeviceAuth` throws
   * "Must call authenticate() first" otherwise. The shared E2E identity used
   * by `signWithIdentityKey` is held in memory and is NOT subject to this,
   * which is why identity signing succeeds while device-auth signing fails on
   * the same call.
   *
   * If already unlocked we just refresh the window (touch); otherwise we
   * re-open it via biometric/passcode. Concurrent callers (connectAll
   * authenticates every server in parallel) share a single in-flight unlock so
   * we never stack multiple prompts.
   */
  private async ensureKeystoreUnlocked(): Promise<void> {
    const SignalProtocol = require('signal-protocol').default;

    try {
      const { authenticated } = SignalProtocol.isAuthenticated();
      if (authenticated) {
        // Refresh the window so a slow auth flow (e.g. challenge over Tor)
        // doesn't expire between this check and signWithDeviceAuth.
        SignalProtocol.extendAuthentication();
        return;
      }
    } catch (error) {
      logger.warn('[ServerRegistry] isAuthenticated check failed, attempting unlock:', error);
    }

    if (!this.unlockInFlight) {
      this.unlockInFlight = (async () => {
        logger.info('[ServerRegistry] Keystore locked — requesting unlock before server auth');
        diagnostics.event('keystore', 'unlock.request');
        const result = await SignalProtocol.authenticate(
          'Sblocca le chiavi per autenticarti con il server'
        );
        if (!result?.success) {
          diagnostics.error('keystore', 'unlock.fail', { errMsg: result?.error ?? null });
          throw new Error(
            'Keystore unlock required for server authentication: ' +
              (result?.error || 'authentication failed')
          );
        }
        diagnostics.event('keystore', 'unlock.ok');
      })().finally(() => {
        this.unlockInFlight = null;
      });
    }

    await this.unlockInFlight;
  }

  /**
   * Upload public key bundle to a server.
   */
  private async uploadPreKeysToServer(serverId: number): Promise<void> {
    const SignalProtocol = require('signal-protocol').default;
    const api = this.getApi(serverId);

    const bundle = await SignalProtocol.getFullPublicBundle();
    // ADR-0010: register this device's server-auth public key alongside the
    // bundle (TOFU-bound server-side on first upload, idempotent after).
    const { publicKey: deviceAuthPublicKey } = await SignalProtocol.getDeviceAuthPublicKey();
    // Server accepts max 100 pre-keys per upload. After replenishments
    // the native keystore may hold more — send only the first 100.
    const preKeys = bundle.preKeys.slice(0, 100);
    const kyberPreKeys = bundle.kyberPreKeys.slice(0, 100);
    await api.syncPublicKeys({
      deviceId: bundle.deviceId,
      registrationId: bundle.registrationId,
      identityPublicKey: bundle.identityPublicKey,
      deviceAuthPublicKey,
      signedPreKey: {
        keyId: bundle.signedPreKey.id,
        keyData: bundle.signedPreKey.publicKey,
        signature: bundle.signedPreKey.signature,
      },
      preKeys: preKeys.map((pk: any) => ({
        keyId: pk.id,
        keyData: pk.publicKey,
      })),
      kyberPreKeys: kyberPreKeys.map((kpk: any) => ({
        keyId: kpk.id,
        keyData: kpk.publicKey,
        signature: kpk.signature,
      })),
    });
  }

  /**
   * Remove a server: disconnect, cleanup instances, remove rooms, remove from DB.
   */
  async removeServer(serverId: number): Promise<void> {
    const server = this.serverMap.get(serverId);
    if (server?.isDefault === 1) {
      throw new Error('Cannot remove default server');
    }

    logger.info(`[ServerRegistry] Removing server ${serverId}...`);

    // Disconnect
    const socket = this.sockets.get(serverId);
    socket?.disconnect();
    socket?.clearAllServiceHandlers();

    // Delete all rooms belonging to this server (DB + store)
    try {
      const deletedRoomIds = await roomRepository.hardDeleteByServerId(serverId);
      logger.info(`[ServerRegistry] Deleted ${deletedRoomIds.length} rooms for server ${serverId}:`, deletedRoomIds);

      // Remove rooms from chat store
      const chatStore = useChatStore.getState();
      for (const roomId of deletedRoomIds) {
        chatStore.removeRoomFromList(roomId);
        chatStore.clearRoom(roomId);
      }
    } catch (error) {
      logger.warn(`[ServerRegistry] Error deleting rooms for server ${serverId}:`, error);
    }

    // Clear token from SecureStore
    try {
      await SecureStore.deleteItemAsync(`token_server_${serverId}`);
    } catch (error) {
      logger.warn(`[ServerRegistry] Error clearing token for server ${serverId}:`, error);
    }

    // Cleanup instances
    this.apis.delete(serverId);
    this.sockets.delete(serverId);
    this.serverMap.delete(serverId);

    // Remove from DB
    await serverRepository.remove(serverId);

    // Update store
    useServerStore.getState().removeServer(serverId);

    logger.info('[ServerRegistry] Server removed:', serverId);
  }

  /**
   * Clear all instances (for logout/teardown).
   */
  clearAll(): void {
    this.disconnectAll();
    for (const socket of this.sockets.values()) {
      socket.clearAllServiceHandlers();
    }
    this.apis.clear();
    this.sockets.clear();
    this.serverMap.clear();
  }

  // ========================================
  // INTERNAL
  // ========================================

  /**
   * Compare default server URLs in DB with current env vars.
   * If they differ (e.g. after an app update), update DB and the in-memory array.
   */
  private async syncDefaultServerFromEnv(defaultServer: Server, dbServers: Server[]): Promise<void> {
    const envApiUrl = process.env.EXPO_PUBLIC_API_URL || 'https://api.tillit.cc';
    const envSocketUrl = process.env.EXPO_PUBLIC_SOCKET_URL || envApiUrl;
    const envNamespace = process.env.EXPO_PUBLIC_SOCKET_NAMESPACE || '/chat';

    const expectedName = 'TilliT Cloud';
    const needsUpdate =
      defaultServer.apiUrl !== envApiUrl ||
      defaultServer.socketUrl !== envSocketUrl ||
      defaultServer.socketNamespace !== envNamespace ||
      defaultServer.name !== expectedName;

    if (!needsUpdate) return;

    logger.info(
      `[ServerRegistry] Default server config changed — updating DB` +
      ` (api: ${defaultServer.apiUrl} → ${envApiUrl},` +
      ` socket: ${defaultServer.socketUrl} → ${envSocketUrl},` +
      ` ns: ${defaultServer.socketNamespace} → ${envNamespace},` +
      ` name: ${defaultServer.name} → ${expectedName})`
    );

    await serverRepository.update(defaultServer.id, {
      name: expectedName,
      apiUrl: envApiUrl,
      socketUrl: envSocketUrl,
      socketNamespace: envNamespace,
    });

    // Update the in-memory object so createInstances uses the new values
    defaultServer.name = expectedName;
    defaultServer.apiUrl = envApiUrl;
    defaultServer.socketUrl = envSocketUrl;
    defaultServer.socketNamespace = envNamespace;
  }

  private createInstances(server: Server): void {
    const useTor = this.isServerTor(server);
    const api = new ApiService(server.id, server.apiUrl, useTor);
    const socket = new SocketService(server.id, server.socketUrl, server.socketNamespace, useTor);
    socket.setTokenGetter(() => api.getToken());
    socket.setAuthChecker(() => this.authCheckerFn?.() ?? false);

    this.apis.set(server.id, api);
    this.sockets.set(server.id, socket);
  }

  /**
   * Determine if a server should use Tor.
   * Either the `isTor` flag is set in DB, or the URL contains `.onion`.
   */
  private isServerTor(server: Server): boolean {
    return (server as any).isTor === 1 || isOnionUrl(server.apiUrl) || isOnionUrl(server.socketUrl);
  }

  /**
   * Check if any configured server requires Tor.
   */
  hasAnyTorServer(): boolean {
    for (const server of this.serverMap.values()) {
      if (this.isServerTor(server)) return true;
    }
    return false;
  }

  /**
   * Resolve a room-ID-derived serverId (from the offset encoding) to the
   * actual DB server id.
   *
   * Room IDs for the default server have serverId=0 (via the offset).
   * But the default server's DB id may be 1 (auto-increment).
   * So serverId=0 → default server DB id.
   * For non-default servers, the room offset serverId matches the DB id directly.
   */
  private resolveServerId(localRoomId: number): number {
    const offsetServerId = getServerIdFromRoomId(localRoomId);
    if (offsetServerId === 0) {
      return this.getDefaultServerId();
    }
    return offsetServerId;
  }
}

export const serverRegistry = new ServerRegistry();
