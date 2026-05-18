import SignalProtocol from 'signal-protocol';
import * as SecureStore from 'expo-secure-store';
import { serverRegistry } from './server-registry';
import { sessionRepository } from '@/db/repositories/session.repository';
import { profileRepository } from '@/db/repositories/profile.repository';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { logger } from '@/utils/logger';
import { Session } from '@/db/schema';
import { getServerIdFromRoomId } from '@/utils/server-id';
import { PRIMARY_DEVICE_ID } from '@/config/app.config';

const PREKEY_THRESHOLD = 10;
const PREKEY_BATCH_SIZE = 50;
const SIGNED_PREKEY_ROTATE_DAYS = 30;
const LAST_SIGNED_PREKEY_ROTATION_KEY = 'last_signed_prekey_rotation';

/**
 * Thrown when the server returns a remote user's identity key that doesn't match
 * the one already stored locally. Signals a potential MITM during session recovery.
 * Callers MUST NOT proceed with applying the new keys — the existing session is
 * preserved and a security alert is surfaced to the user via the app store.
 */
export class IdentityKeyMismatchError extends Error {
  constructor(public readonly remoteUserId: string) {
    super(`Identity key mismatch for remote user ${remoteUserId}`);
    this.name = 'IdentityKeyMismatchError';
  }
}

class SessionService {
  sessions: Map<number, Session[]> = new Map();

  private deviceId = PRIMARY_DEVICE_ID;
  private lastPreKeyId = 0;
  private lastKyberPreKeyId = 0;
  private lastSignedPreKeyRotation = 0;
  private refreshLocks = new Set<number>(); // per-server lock
  private lastRefreshTime = new Map<number, number>(); // per-server
  private readonly REFRESH_THROTTLE_MS = 60_000;

  private getOwnUserId(): number | null {
    return useAuthStore.getState().userId;
  }

  /**
   * Resolve API service for a room ID.
   */
  private getApiForRoom(roomId: number) {
    return serverRegistry.getApiForRoom(roomId);
  }

  /**
   * Establish a new session with a remote user.
   */
  async setSession(
    roomId: number,
    remoteUserId: number,
    username: string,
    deviceId: number = PRIMARY_DEVICE_ID
  ): Promise<boolean> {
    const ownUserId = this.getOwnUserId();
    // Check both global userId and server-specific userId to prevent self-session
    const serverUserId = serverRegistry.getUserIdForRoom(roomId);
    if ((ownUserId && remoteUserId === ownUserId) || (serverUserId && remoteUserId === serverUserId)) {
      logger.info('[SessionService] Blocked self-session creation:', remoteUserId, '(ownUserId:', ownUserId, 'serverUserId:', serverUserId, ')');
      return false;
    }

    logger.info('[SessionService] Setting session with', remoteUserId, 'room:', roomId);

    const remoteUserIdStr = String(remoteUserId);

    const existingSession = await sessionRepository.findByUserAndRoom(remoteUserIdStr, roomId);

    if (existingSession) {
      logger.info('[SessionService] Session already exists, resuming');
      try {
        await this.resumeSession(roomId, remoteUserIdStr, username, deviceId);
        return true;
      } catch (error) {
        if (error instanceof IdentityKeyMismatchError) {
          // MITM suspected during recovery — do NOT recreate the session,
          // which would silently accept the new identity key.
          throw error;
        }
        logger.info('[SessionService] Resume failed, recreating session:', error);
      }
    }

    const api = this.getApiForRoom(roomId);
    logger.info('[SessionService] Fetching remote keys for user', remoteUserId);
    let remoteKeys: any;
    try {
      remoteKeys = await api.getRemoteKeys(remoteUserIdStr);
    } catch (error) {
      logger.error('[SessionService] Failed to fetch remote keys:', error);
      return false;
    }

    if (!remoteKeys) {
      logger.error('[SessionService] Remote keys not found');
      return false;
    }

    const preKey = remoteKeys.preKey || null;
    const kyberPreKey = remoteKeys.kyberPreKey || null;
    const signedPreKey = remoteKeys.signedPreKey || null;

    if (!preKey || !kyberPreKey || !signedPreKey || !remoteKeys.identityPublicKey) {
      logger.error('[SessionService] Missing pre-keys in response');
      return false;
    }

    const formattedKeys = {
      remoteUserId: remoteUserIdStr,
      deviceId: Number(remoteKeys.deviceId || preKey?.deviceId || kyberPreKey?.deviceId || 1),
      name: remoteUserIdStr,
      registrationId: Number(remoteKeys.registrationId),
      identityPublicKey: String(remoteKeys.identityPublicKey || ''),
      signedPreKeyId: Number(signedPreKey?.keyId),
      signedPreKeyPublicKey: String(signedPreKey?.keyData || ''),
      signedPreKeySignature: String(signedPreKey?.signature || ''),
      preKeyId: Number(preKey?.keyId),
      preKeyPublicKey: String(preKey?.keyData || ''),
      kyberPreKeyId: Number(kyberPreKey?.keyId),
      kyberPreKeyPublicKey: String(kyberPreKey?.keyData || ''),
      kyberPreKeySignature: String(kyberPreKey?.signature || ''),
    };

    if (!this.validateRemoteKeys(formattedKeys)) {
      return false;
    }

    let sessionEstablished = false;

    try {
      await SignalProtocol.setRemoteUserKeys({
        remoteUserId: remoteUserIdStr,
        preKeyId: formattedKeys.preKeyId,
        preKeyPublicKey: formattedKeys.preKeyPublicKey,
        signedPreKeyId: formattedKeys.signedPreKeyId,
        signedPreKeyPublicKey: formattedKeys.signedPreKeyPublicKey,
        signedPreKeySignature: formattedKeys.signedPreKeySignature,
        identityPublicKey: formattedKeys.identityPublicKey,
        registrationId: formattedKeys.registrationId,
        deviceId: formattedKeys.deviceId,
        name: formattedKeys.name,
        kyberPreKeyId: formattedKeys.kyberPreKeyId,
        kyberPreKeyPublicKey: formattedKeys.kyberPreKeyPublicKey,
        kyberPreKeySignature: formattedKeys.kyberPreKeySignature,
      });

      await SignalProtocol.establishSession(remoteUserIdStr);
      sessionEstablished = true;
      logger.info('[SessionService] Session established successfully');
    } catch (error: any) {
      logger.error('[SessionService] Failed to establish session:', error?.message || error);

      try {
        await sessionRepository.deleteByUserAndRoom(remoteUserIdStr, roomId);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      return false;
    }

    if (sessionEstablished) {
      const now = Math.floor(Date.now() / 1000);
      await sessionRepository.upsert({
        idUser: remoteUserIdStr,
        idRoom: roomId,
        remoteUserName: username || formattedKeys.name,
        remoteUserDeviceId: formattedKeys.deviceId,
        identityVerified: 0,
        created: existingSession?.created ?? now,
        lastModified: now,
      });

      await profileRepository.upsert({
        idUser: remoteUserId,
        idRoom: roomId,
        username: username || `user-${remoteUserId}`,
      });

      const sessions = await sessionRepository.findByRoom(roomId);
      this.sessions.set(roomId, sessions);
    }

    return sessionEstablished;
  }

  async hasSession(roomId: number, userId: number): Promise<boolean> {
    return sessionRepository.exists(String(userId), roomId);
  }

  async resumeSession(
    roomId: number,
    userId: string,
    username: string,
    deviceId: number = PRIMARY_DEVICE_ID
  ): Promise<void> {
    logger.info('[SessionService] Resuming session with', userId);

    try {
      await SignalProtocol.resumeSession(String(userId), username, deviceId);
      logger.info('[SessionService] Session resumed successfully');
    } catch (error) {
      logger.info('[SessionService] Resume failed, attempting recovery:', error);
      await this.recoverSession(roomId, String(userId), username);
    }
  }

  async ensureSession(roomId: number, userId: number): Promise<boolean> {
    const exists = await this.hasSession(roomId, userId);
    if (exists) {
      const session = await sessionRepository.findByUserAndRoom(String(userId), roomId);
      if (session) {
        try {
          await this.resumeSession(roomId, session.idUser, session.remoteUserName, session.remoteUserDeviceId);
          return true;
        } catch {
          // Fall through to create new session
        }
      }
    }

    return this.setSession(roomId, userId, `user-${userId}`);
  }

  async ensureSessionInDatabase(roomId: number, remoteUserId: string): Promise<void> {
    const existing = await sessionRepository.findByUserAndRoom(remoteUserId, roomId);
    if (existing) return;

    const now = Math.floor(Date.now() / 1000);
    try {
      await sessionRepository.create({
        idUser: remoteUserId,
        idRoom: roomId,
        remoteUserName: `user-${remoteUserId}`,
        remoteUserDeviceId: 1,
        created: now,
        lastModified: now,
        identityVerified: 0,
      });

      const sessions = await sessionRepository.findByRoom(roomId);
      this.sessions.set(roomId, sessions);
    } catch (error) {
      logger.info('[SessionService] ensureSessionInDatabase: likely already exists', error);
    }
  }

  async loadSessions(roomId?: number): Promise<Session[]> {
    let sessionsList: Session[];

    if (roomId) {
      sessionsList = await sessionRepository.findByRoom(roomId);
    } else {
      sessionsList = await sessionRepository.findAll();
    }

    const resumedUsers = new Set<string>();

    for (const session of sessionsList) {
      const userId = String(session.idUser);
      if (resumedUsers.has(userId)) continue;

      try {
        await SignalProtocol.resumeSession(userId, session.remoteUserName, session.remoteUserDeviceId);
        resumedUsers.add(userId);
      } catch (error) {
        logger.info('[SessionService] Error resuming session for', userId, error);
      }
    }

    logger.info(`[SessionService] Resumed ${resumedUsers.size} unique sessions out of ${sessionsList.length} total`);

    if (roomId) {
      this.sessions.set(roomId, sessionsList);
    } else {
      this.sessions.clear();
      for (const session of sessionsList) {
        if (!this.sessions.has(session.idRoom)) {
          this.sessions.set(session.idRoom, []);
        }
        this.sessions.get(session.idRoom)!.push(session);
      }
    }

    return sessionsList;
  }

  async recoverSession(roomId: number, remoteUserId: string, _remoteUserName: string): Promise<void> {
    logger.info('[SessionService] Attempting recovery for', remoteUserId);

    let remoteKeys: any;
    try {
      remoteKeys = await this.fetchRemoteKeys(roomId, remoteUserId);
    } catch (error) {
      logger.error('[SessionService] Recovery fetch failed:', error);
      throw new Error(`Failed to recover session for user ${remoteUserId}: ${error}`);
    }

    // Compare the freshly fetched identity key with the one already trusted.
    // A mismatch means the server (or someone tampering with it) is trying to
    // substitute the remote user's identity while we're rebuilding the session.
    await this.assertIdentityNotChanged(roomId, remoteUserId, String(remoteKeys.identityPublicKey || ''));

    try {
      await this.applyRemoteKeys(remoteUserId, remoteKeys);
      await SignalProtocol.establishSession(String(remoteUserId));
      logger.info('[SessionService] Session recovered for', remoteUserId);
    } catch (error) {
      logger.error('[SessionService] Recovery failed:', error);
      throw new Error(`Failed to recover session for user ${remoteUserId}: ${error}`);
    }
  }

  private async assertIdentityNotChanged(
    roomId: number,
    remoteUserId: string,
    newIdentityKey: string
  ): Promise<void> {
    // A row in sessionRepository means we previously established trust with this
    // user's identity. If it's there, "No identity saved yet" or a native error
    // is NOT a valid TOFU situation — silently accepting a new identity would
    // bypass the gating. TOFU is allowed only on genuine first contact (no row).
    const priorSession = await sessionRepository.findByUserAndRoom(remoteUserId, roomId);

    let result: { changed: boolean; reason?: string } | undefined;
    let nativeError: unknown;
    try {
      result = await SignalProtocol.checkIdentityKeyChanged(remoteUserId, newIdentityKey);
    } catch (error) {
      nativeError = error;
    }

    if (result?.changed) {
      this.handleIdentityKeyChanged(roomId, Number(remoteUserId));
      throw new IdentityKeyMismatchError(remoteUserId);
    }

    const nativeHasNoIdentity =
      nativeError !== undefined ||
      (typeof result?.reason === 'string' && /No identity saved/i.test(result.reason));

    if (nativeHasNoIdentity && priorSession) {
      logger.error(
        '[SessionService] Identity gating: prior session exists for',
        remoteUserId,
        'but native store has no trusted identity — refusing to TOFU on recovery',
        nativeError ? `(native error: ${(nativeError as any)?.message ?? nativeError})` : '(reason: No identity saved yet)'
      );
      this.handleIdentityKeyChanged(roomId, Number(remoteUserId));
      throw new IdentityKeyMismatchError(remoteUserId);
    }

    if (nativeHasNoIdentity) {
      logger.info(
        '[SessionService] Identity check: no prior trust, allowing TOFU for',
        remoteUserId
      );
    }
  }

  handleIdentityKeyChanged(roomId: number, userId: number): void {
    logger.warn('[SessionService] Identity key changed for user', userId, 'in room', roomId);
    useAppStore.getState().addSecurityAlert({
      roomId,
      userId,
      type: 'identity_key_changed',
      message: 'La chiave di sicurezza di questo utente è cambiata. Verifica la sua identità prima di continuare.',
    });
  }

  async checkIdentityChanged(roomId: number, remoteUserId: string): Promise<boolean> {
    const { changed, reason } = await SignalProtocol.checkIdentityKeyChanged(remoteUserId);

    if (reason && reason.includes('No identity saved')) {
      try {
        const keys = await this.fetchRemoteKeys(roomId, remoteUserId);
        await this.applyRemoteKeys(remoteUserId, keys);
        const result = await SignalProtocol.checkIdentityKeyChanged(remoteUserId);
        return result.changed;
      } catch (error) {
        logger.error('[SessionService] Failed to reload keys:', error);
        throw error;
      }
    }

    return changed;
  }

  async initializePreKeyTracking(): Promise<void> {
    try {
      const bundle = await SignalProtocol.getFullPublicBundle();

      this.deviceId = bundle.deviceId || PRIMARY_DEVICE_ID;

      if (bundle.preKeys && bundle.preKeys.length > 0) {
        this.lastPreKeyId = Math.max(...bundle.preKeys.map((k: any) => Number(k.id)));
      }
      if (bundle.kyberPreKeys && bundle.kyberPreKeys.length > 0) {
        this.lastKyberPreKeyId = Math.max(...bundle.kyberPreKeys.map((k: any) => Number(k.id)));
      }

      try {
        const stored = await SecureStore.getItemAsync(LAST_SIGNED_PREKEY_ROTATION_KEY);
        if (stored) {
          this.lastSignedPreKeyRotation = Number(stored);
        }
      } catch {
        // SecureStore not available or value not set
      }

      logger.info(
        '[SessionService] Pre-key tracking initialized: deviceId=', this.deviceId,
        'lastPreKeyId=', this.lastPreKeyId,
        'lastKyberPreKeyId=', this.lastKyberPreKeyId,
        'lastSignedPreKeyRotation=', this.lastSignedPreKeyRotation
      );
    } catch (error) {
      logger.warn('[SessionService] Failed to initialize pre-key tracking:', error);
    }
  }

  /**
   * Refresh pre-keys if needed.
   * If serverId is provided, only refresh for that server.
   * If not provided, refresh for ALL servers.
   */
  async refreshPreKeysIfNeeded(serverId?: number): Promise<void> {
    if (!useAuthStore.getState().isAuthenticated) return;
    if (useAppStore.getState().isInBackground) return;
    if (!this.isNativeAuthAvailable()) return;

    const serverIds = serverId !== undefined
      ? [serverId]
      : serverRegistry.getAllServers().map((s) => s.id);

    for (const sid of serverIds) {
      await this.refreshPreKeysForServer(sid);
    }
  }

  private async refreshPreKeysForServer(serverId: number): Promise<void> {
    if (this.refreshLocks.has(serverId)) return;
    const now = Date.now();
    const lastRefresh = this.lastRefreshTime.get(serverId) ?? 0;
    if (now - lastRefresh < this.REFRESH_THROTTLE_MS) return;

    this.refreshLocks.add(serverId);
    try {
      const api = serverRegistry.getApi(serverId);
      const token = await api.getToken();
      if (!token) return;

      const status = await api.getKeyStatus();
      if (!status) return;

      const tasks: Promise<void>[] = [];
      const preKeysCount = status.preKeysCount ?? 0;
      const kyberPreKeysCount = status.kyberPreKeysCount ?? 0;

      if (preKeysCount < PREKEY_THRESHOLD) {
        tasks.push(this.replenishPreKeys(serverId));
      }
      if (kyberPreKeysCount < PREKEY_THRESHOLD) {
        tasks.push(this.replenishKyberPreKeys(serverId));
      }
      tasks.push(this.rotateSignedPreKeyIfNeeded(serverId));

      await Promise.all(tasks);
      this.lastRefreshTime.set(serverId, Date.now());
    } catch (error) {
      logger.info(`[SessionService] refreshPreKeysForServer(${serverId}) error:`, error);
    } finally {
      this.refreshLocks.delete(serverId);
    }
  }

  async rotateSignedPreKeyIfNeeded(serverId: number): Promise<void> {
    const lastRotation = this.lastSignedPreKeyRotation;
    const daysSinceRotation = (Date.now() / 1000 - lastRotation) / (60 * 60 * 24);

    if (daysSinceRotation < SIGNED_PREKEY_ROTATE_DAYS) return;
    if (!this.isNativeAuthAvailable()) return;

    try {
      const signedPreKey = await SignalProtocol.rotateSignedPreKey();

      const now = Math.floor(Date.now() / 1000);
      this.lastSignedPreKeyRotation = now;
      await SecureStore.setItemAsync(LAST_SIGNED_PREKEY_ROTATION_KEY, String(now));

      const api = serverRegistry.getApi(serverId);
      await api.syncPublicKeys({
        deviceId: this.deviceId,
        signedPreKey: {
          keyId: signedPreKey.id,
          keyData: signedPreKey.publicKey,
          signature: signedPreKey.signature,
        },
      });

      logger.info('[SessionService] Signed pre-key rotated');
    } catch (error: any) {
      if (error?.message?.includes('Must authenticate')) {
        logger.info('[SessionService] Signed pre-key rotation skipped: keychain locked (will retry on foreground)');
      } else {
        logger.error('[SessionService] Signed pre-key rotation failed:', error);
      }
    }
  }

  async updateSessionTimestamp(roomId: number, userId: string): Promise<void> {
    const session = await sessionRepository.findByUserAndRoom(userId, roomId);
    if (session) {
      await sessionRepository.updateLastMessageAt(session.id);
    }
  }

  async deleteSession(roomId: number, userId: string): Promise<void> {
    await sessionRepository.deleteByUserAndRoom(userId, roomId);

    const sessions = await sessionRepository.findByRoom(roomId);
    this.sessions.set(roomId, sessions);
  }

  async deleteSessionsByRoom(roomId: number): Promise<void> {
    await sessionRepository.deleteByRoom(roomId);
    this.sessions.delete(roomId);
  }

  // ========================================
  // Private helpers
  // ========================================

  private isNativeAuthAvailable(): boolean {
    try {
      const { authenticated } = SignalProtocol.isAuthenticated();
      if (!authenticated) {
        logger.info('[SessionService] Native module not authenticated');
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pure fetch: returns the raw remote keys response without touching the
   * native crypto store. Split from {@link applyRemoteKeys} so that callers
   * can inspect/validate the response (e.g. identity key comparison) before
   * committing the new keys to the protocol store.
   */
  private async fetchRemoteKeys(roomId: number, remoteUserId: string): Promise<any> {
    const api = this.getApiForRoom(roomId);
    const remoteKeys = await api.getRemoteKeys(remoteUserId);
    if (!remoteKeys) throw new Error('Remote keys not found');
    return remoteKeys;
  }

  /**
   * Commit fetched remote keys to the native protocol store. Caller is
   * responsible for any validation (e.g. identity key trust check) prior
   * to invoking this — once called, the local identity store is updated.
   */
  private async applyRemoteKeys(remoteUserId: string, remoteKeys: any): Promise<void> {
    const preKey = remoteKeys.preKey || null;
    const kyberPreKey = remoteKeys.kyberPreKey || null;
    const signedPreKey = remoteKeys.signedPreKey || null;

    await SignalProtocol.setRemoteUserKeys({
      remoteUserId: String(remoteUserId),
      preKeyId: Number(preKey?.keyId),
      preKeyPublicKey: String(preKey?.keyData || ''),
      signedPreKeyId: Number(signedPreKey?.keyId),
      signedPreKeyPublicKey: String(signedPreKey?.keyData || ''),
      signedPreKeySignature: String(signedPreKey?.signature || ''),
      identityPublicKey: String(remoteKeys.identityPublicKey || ''),
      registrationId: Number(remoteKeys.registrationId),
      deviceId: Number(remoteKeys.deviceId || 1),
      name: String(remoteUserId),
      kyberPreKeyId: Number(kyberPreKey?.keyId),
      kyberPreKeyPublicKey: String(kyberPreKey?.keyData || ''),
      kyberPreKeySignature: String(kyberPreKey?.signature || ''),
    });
  }

  private async replenishPreKeys(serverId: number): Promise<void> {
    const startId = this.lastPreKeyId + 1;
    const { preKeys } = await SignalProtocol.replenishPreKeys(startId, PREKEY_BATCH_SIZE);

    this.lastPreKeyId = startId + PREKEY_BATCH_SIZE - 1;

    const api = serverRegistry.getApi(serverId);
    await api.syncPublicKeys({
      deviceId: this.deviceId,
      preKeys: preKeys.map((k: any) => ({
        keyId: k.id,
        keyData: k.publicKey,
      })),
    });

    logger.info(`[SessionService] Pre-keys replenished on server ${serverId}`);
  }

  private async replenishKyberPreKeys(serverId: number): Promise<void> {
    const startId = this.lastKyberPreKeyId + 1;
    const { kyberPreKeys } = await SignalProtocol.replenishKyberPreKeys(startId, PREKEY_BATCH_SIZE);

    this.lastKyberPreKeyId = startId + PREKEY_BATCH_SIZE - 1;

    const api = serverRegistry.getApi(serverId);
    await api.syncPublicKeys({
      deviceId: this.deviceId,
      kyberPreKeys: kyberPreKeys.map((k: any) => ({
        keyId: k.id,
        keyData: k.publicKey,
        signature: k.signature,
      })),
    });

    logger.info(`[SessionService] Kyber pre-keys replenished on server ${serverId}`);
  }

  private validateRemoteKeys(keys: any): boolean {
    const required = [
      'remoteUserId', 'preKeyId', 'preKeyPublicKey',
      'signedPreKeyId', 'signedPreKeyPublicKey', 'signedPreKeySignature',
      'identityPublicKey', 'registrationId', 'deviceId',
      'kyberPreKeyId', 'kyberPreKeyPublicKey', 'kyberPreKeySignature',
    ];

    const missing = required.filter((key) => !keys?.[key] && keys?.[key] !== 0);
    if (missing.length > 0) {
      logger.error('[SessionService] Missing remote key fields:', missing);
      return false;
    }

    if (typeof keys.registrationId !== 'number' || keys.registrationId < 1 || keys.registrationId > 0x3FFF) {
      logger.error('[SessionService] Invalid registrationId:', keys.registrationId);
      return false;
    }

    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    const keyFields = ['identityPublicKey', 'signedPreKeyPublicKey', 'preKeyPublicKey', 'kyberPreKeyPublicKey'];
    for (const field of keyFields) {
      if (typeof keys[field] !== 'string' || keys[field].length === 0 || !base64Regex.test(keys[field])) {
        logger.error('[SessionService] Invalid key format:', field);
        return false;
      }
    }

    return true;
  }
}

export const sessionService = new SessionService();
export default sessionService;
