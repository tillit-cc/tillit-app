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

  /**
   * Multi-device awareness (ADR-0001 D4): `userId → Set<deviceId>` cache,
   * refreshed every time we fetch `/keys/:userId` from the server. The
   * fan-out send path in chat.service uses `getRemoteDeviceIds(userId)`
   * to know how many copies of the same message to encrypt and to which
   * `(userId, deviceId)` slots.
   *
   * Hydrated at boot from the `session.remote_known_devices` column
   * (`loadSessions`) and refreshed lazily on every `/keys/:userId` fetch.
   */
  private deviceMap = new Map<string, Set<number>>();

  /**
   * Throttle for `refreshRemoteDeviceMap`: per-userId timestamp of the last
   * `/keys/:userId` fetch that updated `deviceMap`. Used by the peer-sync
   * path (`chat.service.syncRoomMembersAndSessions`) to avoid hammering the
   * backend with one GET per peer per room on every reconnect.
   */
  private lastDeviceMapRefresh = new Map<string, number>();
  private readonly DEVICE_MAP_REFRESH_THROTTLE_MS = 60_000;

  /**
   * Return the deviceIds the peer has published bundles for. Returns
   * an empty array until the first /keys/:userId fetch has populated the
   * cache. Callers can fall back to `[PRIMARY_DEVICE_ID]` when empty to
   * preserve single-device behavior.
   */
  getRemoteDeviceIds(userId: string): number[] {
    const set = this.deviceMap.get(String(userId));
    return set ? Array.from(set) : [];
  }

  /**
   * Replace the cached deviceIds for a user. Called from
   * `fetchRemoteKeys` after a successful /keys/:userId response.
   *
   * Also persists the list onto every existing `session` row for the user
   * (`remote_known_devices` CSV column). At boot, `loadSessions` re-hydrates
   * `deviceMap` from those rows, so the fan-out send path doesn't fall back
   * to `[PRIMARY_DEVICE_ID]` in the window between restart and the first
   * `onConnected` sync.
   */
  private updateRemoteDeviceMap(userId: string, deviceIds: number[]): void {
    const key = String(userId);
    if (deviceIds.length === 0) {
      this.deviceMap.delete(key);
      // Don't wipe the persisted column on transient empty responses; keep
      // the last known good list.
      return;
    }
    this.deviceMap.set(key, new Set(deviceIds));
    this.lastDeviceMapRefresh.set(key, Date.now());
    // Best-effort persistence — never block the in-memory update on DB IO.
    sessionRepository
      .updateRemoteKnownDevicesForUser(key, deviceIds)
      .catch((err) => logger.warn('[SessionService] persist deviceMap failed:', err));
  }

  /**
   * Drop the cached deviceIds for a user. The next `getRemoteDeviceIds` will
   * report an empty list and the next `encrypt` fan-out will trigger a fresh
   * `/keys/:userId` via `refreshRemoteDeviceMap` (or fall back to
   * `[PRIMARY_DEVICE_ID]` until then).
   *
   * Used by the peer-device-linked socket handler (frontend-0008 / Opzione 3)
   * to react to backend-pushed cache invalidations.
   */
  invalidateRemoteDeviceMap(userId: string): void {
    const key = String(userId);
    this.deviceMap.delete(key);
    this.lastDeviceMapRefresh.delete(key);
    sessionRepository
      .updateRemoteKnownDevicesForUser(key, [])
      .catch((err) => logger.warn('[SessionService] invalidate deviceMap persist failed:', err));
  }

  /**
   * Force-refresh the multi-device cache for a peer WITHOUT touching the
   * libsignal session state. Used by the peer-sync path when we already
   * have an established session but want to discover newly-linked devices
   * the peer published since the last fetch.
   *
   * Throttled per-userId (60s by default) so calling this for every member
   * of every room on each `onConnected` doesn't fan into N×M HTTP requests.
   * Pass `force: true` to bypass the throttle (e.g. handler of an explicit
   * `peerDeviceLinked` push notification).
   */
  async refreshRemoteDeviceMap(
    roomId: number,
    remoteUserId: string,
    options: { force?: boolean } = {},
  ): Promise<number[]> {
    const key = String(remoteUserId);
    const now = Date.now();
    const last = this.lastDeviceMapRefresh.get(key) ?? 0;
    if (!options.force && now - last < this.DEVICE_MAP_REFRESH_THROTTLE_MS) {
      return this.getRemoteDeviceIds(key);
    }

    const api = this.getApiForRoom(roomId);
    let remoteKeys: any;
    try {
      remoteKeys = await api.getRemoteKeys(key);
    } catch (err) {
      logger.warn('[SessionService] refreshRemoteDeviceMap fetch failed for', key, err);
      return this.getRemoteDeviceIds(key);
    }

    const bundles = this.bundlesFromResponse(remoteKeys);
    const deviceIds = bundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);

    this.updateRemoteDeviceMap(key, deviceIds);
    return deviceIds;
  }

  /**
   * Normalize the response shape of `GET /keys/:userId` to an array of
   * bundles. The backend may return `{ devices: [...] }` (multi-device,
   * post backend-0004) or a single bundle (legacy / single-device). Both
   * are accepted to keep the client robust across the transition.
   */
  private bundlesFromResponse(remoteKeys: any): any[] {
    if (remoteKeys?.devices && Array.isArray(remoteKeys.devices) && remoteKeys.devices.length > 0) {
      return remoteKeys.devices.map((b: any) => this.normalizeBundle(b));
    }
    if (remoteKeys && (remoteKeys.identityPublicKey || remoteKeys.identityKey || remoteKeys.signedPreKey)) {
      return [this.normalizeBundle(remoteKeys)];
    }
    return [];
  }

  /**
   * Normalize wire field renames between v1 (single-device) and v2
   * (multi-device): the backend's `GET /keys/:userId` v2 shape renames
   * `identityPublicKey` → `identityKey`. We keep both names on the
   * normalized bundle so downstream code (which reads `identityPublicKey`)
   * keeps working without further branching.
   */
  private normalizeBundle(bundle: any): any {
    if (!bundle || typeof bundle !== 'object') return bundle;
    if (!bundle.identityPublicKey && bundle.identityKey) {
      return { ...bundle, identityPublicKey: bundle.identityKey };
    }
    return bundle;
  }

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
      // Refresh the multi-device cache even when keeping the existing session
      // — otherwise newly-linked peer devices published since the last fetch
      // never enter the fan-out, and we keep encrypting only for the device
      // list that was current at the original session establishment.
      // Throttled per-userId so this is cheap when called for every peer on
      // each `onConnected`.
      this.refreshRemoteDeviceMap(roomId, remoteUserIdStr).catch(() => {
        // Already logged inside refreshRemoteDeviceMap; never let a refresh
        // failure block the resume path.
      });
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

    // Multi-device cache refresh (ADR-0001 D4). The legacy single-device
    // path below continues with `remoteKeys` as a single bundle — if the
    // server returned the `{ devices: [...] }` array shape, pick the
    // bundle matching the deviceId we were asked to set up (default to
    // the first one). Other devices' bundles surface to the fan-out
    // send path via `getRemoteDeviceIds`.
    const allBundles = this.bundlesFromResponse(remoteKeys);
    const allDeviceIds = allBundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);
    this.updateRemoteDeviceMap(remoteUserIdStr, allDeviceIds);
    if (allBundles.length > 0) {
      const requested = allBundles.find((b) => Number(b.deviceId) === Number(deviceId));
      remoteKeys = requested ?? allBundles[0];
    }

    const preKey = remoteKeys.preKey || null;
    const kyberPreKey = remoteKeys.kyberPreKey || null;
    const signedPreKey = remoteKeys.signedPreKey || null;

    if (!preKey || !kyberPreKey || !signedPreKey || !remoteKeys.identityPublicKey) {
      logger.error('[SessionService] Missing pre-keys in response. Got fields:', {
        hasIdentityPublicKey: !!remoteKeys.identityPublicKey,
        hasIdentityKey: !!remoteKeys.identityKey,
        hasRegistrationId: remoteKeys.registrationId !== undefined && remoteKeys.registrationId !== null,
        hasSignedPreKey: !!signedPreKey,
        hasPreKey: !!preKey,
        hasKyberPreKey: !!kyberPreKey,
        topLevelKeys: Object.keys(remoteKeys || {}),
      });
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

      await SignalProtocol.establishSession(remoteUserIdStr, formattedKeys.deviceId);
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

  /**
   * Establish a libsignal session with one of the user's OWN linked devices.
   *
   * Used by Fase C (sender-key redistribution after `deviceLinked`) where the
   * primary needs to encrypt a distribution message for `(ownUserId, deviceId)`.
   *
   * Bypasses the anti-self guard in `setSession`: the target is a *different*
   * device under the same userId, which is a legitimate libsignal session
   * (libsignal keys sessions by `(userId, deviceId)` so two devices of the
   * same user are distinct addresses).
   *
   * N>1 linked simultanei: the `session` table's unique index is
   * `(idUser, idRoom, remoteUserDeviceId)` (migration v3), and the
   * `upsert()` call below pins on the same triple, so a user can have N
   * self-session rows per room — one per linked device. Both peer-side
   * fan-out and self-side fan-out iterate the full deviceId cache from
   * `getRemoteDeviceIds`, so all linked devices stay in sync across a
   * restart.
   */
  async ensureSessionForOwnLinkedDevice(
    roomId: number,
    ownUserId: number,
    deviceId: number,
  ): Promise<boolean> {
    const ownUserIdStr = String(ownUserId);

    const existing = await sessionRepository.findByUserRoomAndDevice(ownUserIdStr, roomId, deviceId);
    if (existing) {
      try {
        await this.resumeSession(roomId, ownUserIdStr, existing.remoteUserName, deviceId);
        return true;
      } catch {
        // Fall through to recreate from a fresh /keys fetch.
      }
    }

    const api = this.getApiForRoom(roomId);
    let remoteKeys: any;
    try {
      remoteKeys = await api.getRemoteKeys(ownUserIdStr);
    } catch (err) {
      logger.error('[SessionService] ensureSelfLinked: fetch /keys failed:', err);
      return false;
    }

    const bundles = this.bundlesFromResponse(remoteKeys);
    if (bundles.length === 0) {
      logger.warn('[SessionService] ensureSelfLinked: no bundles for own userId');
      return false;
    }

    const allDeviceIds = bundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);
    this.updateRemoteDeviceMap(ownUserIdStr, allDeviceIds);

    const target = bundles.find((b) => Number(b.deviceId) === deviceId);
    if (!target) {
      logger.warn(`[SessionService] ensureSelfLinked: no bundle for device ${deviceId}, available ${allDeviceIds.join(',')}`);
      return false;
    }

    const preKey = target.preKey || null;
    const kyberPreKey = target.kyberPreKey || null;
    const signedPreKey = target.signedPreKey || null;

    if (!preKey || !kyberPreKey || !signedPreKey || !target.identityPublicKey) {
      logger.error('[SessionService] ensureSelfLinked: missing pre-keys in bundle');
      return false;
    }

    try {
      await SignalProtocol.setRemoteUserKeys({
        remoteUserId: ownUserIdStr,
        preKeyId: Number(preKey.keyId),
        preKeyPublicKey: String(preKey.keyData),
        signedPreKeyId: Number(signedPreKey.keyId),
        signedPreKeyPublicKey: String(signedPreKey.keyData),
        signedPreKeySignature: String(signedPreKey.signature),
        identityPublicKey: String(target.identityPublicKey),
        registrationId: Number(target.registrationId),
        deviceId,
        name: `self-${deviceId}`,
        kyberPreKeyId: Number(kyberPreKey.keyId),
        kyberPreKeyPublicKey: String(kyberPreKey.keyData),
        kyberPreKeySignature: String(kyberPreKey.signature),
      });
      await SignalProtocol.establishSession(ownUserIdStr, deviceId);

      const now = Math.floor(Date.now() / 1000);
      await sessionRepository.upsert({
        idUser: ownUserIdStr,
        idRoom: roomId,
        remoteUserName: `self-${deviceId}`,
        remoteUserDeviceId: deviceId,
        identityVerified: 0,
        created: existing?.created ?? now,
        lastModified: now,
      });
      logger.info(`[SessionService] ensureSelfLinked: session ready for (own, ${deviceId}) in room ${roomId}`);
      return true;
    } catch (err) {
      logger.error('[SessionService] ensureSelfLinked: native call failed:', err);
      return false;
    }
  }

  /**
   * Establish a libsignal session with a specific linked device of a PEER.
   *
   * Used by the pair-wise fan-out send path: after the multi-device cache is
   * refreshed (`refreshRemoteDeviceMap`), the deviceMap may include device IDs
   * for which no native session exists yet — typically because the peer linked
   * the device AFTER our original `setSession` completed. Calling
   * `SignalProtocol.encryptMessage(msg, peerId, newDeviceId)` would throw
   * "Session for remoteUserId X (device N) is not initialized". This method
   * lazily fills the gap on a per-(userId, deviceId) basis.
   *
   * Mirrors `ensureSessionForOwnLinkedDevice` but does NOT bypass the
   * self-session guard (we ARE talking to another user). Reuses the same
   * `bundlesFromResponse` shape parsing so it works against both the
   * single-bundle legacy `/keys/:userId` response and the multi-device
   * `{ devices: [...] }` shape.
   */
  async ensureSessionForRemotePeerDevice(
    roomId: number,
    remoteUserId: number | string,
    deviceId: number,
  ): Promise<boolean> {
    const remoteUserIdStr = String(remoteUserId);

    const ownUserId = this.getOwnUserId();
    const serverUserId = serverRegistry.getUserIdForRoom(roomId);
    if (
      (ownUserId && Number(remoteUserIdStr) === ownUserId) ||
      (serverUserId && Number(remoteUserIdStr) === serverUserId)
    ) {
      logger.warn('[SessionService] ensurePeerDevice: refusing to set up self-session for', remoteUserIdStr);
      return false;
    }

    const existing = await sessionRepository.findByUserRoomAndDevice(remoteUserIdStr, roomId, deviceId);
    if (existing) {
      try {
        await this.resumeSession(roomId, remoteUserIdStr, existing.remoteUserName, deviceId);
        return true;
      } catch {
        // Fall through to recreate from a fresh /keys fetch.
      }
    }

    const api = this.getApiForRoom(roomId);
    let remoteKeys: any;
    try {
      remoteKeys = await api.getRemoteKeys(remoteUserIdStr);
    } catch (err) {
      logger.error('[SessionService] ensurePeerDevice: fetch /keys failed for', remoteUserIdStr, err);
      return false;
    }

    const bundles = this.bundlesFromResponse(remoteKeys);
    if (bundles.length === 0) {
      logger.warn('[SessionService] ensurePeerDevice: no bundles for', remoteUserIdStr);
      return false;
    }

    const allDeviceIds = bundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);
    this.updateRemoteDeviceMap(remoteUserIdStr, allDeviceIds);

    const target = bundles.find((b) => Number(b.deviceId) === deviceId);
    if (!target) {
      logger.warn(
        `[SessionService] ensurePeerDevice: no bundle for ${remoteUserIdStr}/${deviceId}, available ${allDeviceIds.join(',')}`,
      );
      return false;
    }

    const preKey = target.preKey || null;
    const kyberPreKey = target.kyberPreKey || null;
    const signedPreKey = target.signedPreKey || null;

    if (!preKey || !kyberPreKey || !signedPreKey || !target.identityPublicKey) {
      logger.error('[SessionService] ensurePeerDevice: missing pre-keys for', remoteUserIdStr, '/', deviceId);
      return false;
    }

    try {
      await SignalProtocol.setRemoteUserKeys({
        remoteUserId: remoteUserIdStr,
        preKeyId: Number(preKey.keyId),
        preKeyPublicKey: String(preKey.keyData),
        signedPreKeyId: Number(signedPreKey.keyId),
        signedPreKeyPublicKey: String(signedPreKey.keyData),
        signedPreKeySignature: String(signedPreKey.signature),
        identityPublicKey: String(target.identityPublicKey),
        registrationId: Number(target.registrationId),
        deviceId,
        name: remoteUserIdStr,
        kyberPreKeyId: Number(kyberPreKey.keyId),
        kyberPreKeyPublicKey: String(kyberPreKey.keyData),
        kyberPreKeySignature: String(kyberPreKey.signature),
      });
      await SignalProtocol.establishSession(remoteUserIdStr, deviceId);

      const now = Math.floor(Date.now() / 1000);
      await sessionRepository.upsert({
        idUser: remoteUserIdStr,
        idRoom: roomId,
        remoteUserName: existing?.remoteUserName ?? `user-${remoteUserIdStr}`,
        remoteUserDeviceId: deviceId,
        identityVerified: 0,
        created: existing?.created ?? now,
        lastModified: now,
      });

      const sessions = await sessionRepository.findByRoom(roomId);
      this.sessions.set(roomId, sessions);

      logger.info(`[SessionService] ensurePeerDevice: session ready for ${remoteUserIdStr}/${deviceId} in room ${roomId}`);
      return true;
    } catch (err) {
      logger.error('[SessionService] ensurePeerDevice: native call failed for', remoteUserIdStr, '/', deviceId, err);
      return false;
    }
  }

  async ensureSessionInDatabase(roomId: number, remoteUserId: string, deviceId?: number): Promise<void> {
    const effectiveDeviceId = deviceId && deviceId > 0 ? deviceId : PRIMARY_DEVICE_ID;

    // Check for the specific (userId, roomId, deviceId) triple — not just
    // any session for that peer. Otherwise messages from a linked device
    // would be silently dropped onto an existing primary-device row, and
    // the (userId, deviceId) libsignal session auto-established during
    // decrypt would never be persisted for future boots.
    const existing = await sessionRepository.findByUserRoomAndDevice(remoteUserId, roomId, effectiveDeviceId);
    if (existing) return;

    const now = Math.floor(Date.now() / 1000);
    try {
      await sessionRepository.create({
        idUser: remoteUserId,
        idRoom: roomId,
        remoteUserName: `user-${remoteUserId}`,
        remoteUserDeviceId: effectiveDeviceId,
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

    // Multi-device: resume one (userId, deviceId) at a time. Previously we
    // deduped on userId alone, which left newly linked peer devices without
    // a native session at boot — the first send path would still work via
    // `ensureSessionForRemotePeerDevice`, but it would have to refetch keys
    // and rebuild the session unnecessarily.
    const resumedKeys = new Set<string>();

    for (const session of sessionsList) {
      const userId = String(session.idUser);

      // Re-hydrate the in-memory deviceMap from the persisted CSV so the
      // fan-out send path knows about all linked peer devices BEFORE the
      // first `/keys/:userId` refresh at `onConnected`. Repeated rows for
      // the same userId carry the same CSV — we read it once per user.
      if (!this.deviceMap.has(userId)) {
        const csv = (session as any).remoteKnownDevices as string | null | undefined;
        if (csv) {
          const ids = csv
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (ids.length > 0) {
            this.deviceMap.set(userId, new Set(ids));
          }
        }
      }

      const sessionKey = `${userId}/${session.remoteUserDeviceId}`;
      if (resumedKeys.has(sessionKey)) continue;

      try {
        await SignalProtocol.resumeSession(userId, session.remoteUserName, session.remoteUserDeviceId);
        resumedKeys.add(sessionKey);
      } catch (error) {
        logger.info('[SessionService] Error resuming session for', sessionKey, error);
      }
    }

    logger.info(`[SessionService] Resumed ${resumedKeys.size} unique (user,device) sessions out of ${sessionsList.length} total`);

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
      // Match the (userId, deviceId) slot that `applyRemoteKeys` just wrote
      // via setRemoteUserKeys — without this, the existence check inside
      // `establishSession` always looks at slot 1 and rejects when the
      // remote user is on a linked device (deviceId != 1).
      const recoveredDeviceId = Number(remoteKeys?.deviceId ?? 1) || 1;
      await SignalProtocol.establishSession(String(remoteUserId), recoveredDeviceId);
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

  /**
   * Bump `lastMessageAt` on the session row(s) for `(roomId, userId)`.
   *
   * When `deviceId` is supplied, only the single `(userId, roomId, deviceId)`
   * row is updated — used by the decrypt path which knows exactly which
   * peer device authored the message. When `deviceId` is omitted (legacy
   * call sites) we stamp EVERY row matching `(userId, roomId)` so a peer
   * with N linked devices doesn't end up with a single row drifting ahead
   * of the others.
   */
  async updateSessionTimestamp(
    roomId: number,
    userId: string,
    deviceId?: number,
  ): Promise<void> {
    if (deviceId !== undefined) {
      const session = await sessionRepository.findByUserRoomAndDevice(userId, roomId, deviceId);
      if (session) {
        await sessionRepository.updateLastMessageAt(session.id);
      }
      return;
    }
    await sessionRepository.updateLastMessageAtForUserRoom(userId, roomId);
  }

  /**
   * Drop the session(s) for `(roomId, userId)`.
   *
   * Without `deviceId`, deletes ALL rows for the user in the room — used
   * when the peer is removed from the room entirely or the room itself
   * goes away. With `deviceId`, deletes only the specific
   * `(userId, roomId, deviceId)` row — used when a single linked device is
   * revoked while others stay reachable.
   */
  async deleteSession(
    roomId: number,
    userId: string,
    deviceId?: number,
  ): Promise<void> {
    if (deviceId !== undefined) {
      await sessionRepository.deleteByUserRoomAndDevice(userId, roomId, deviceId);
    } else {
      await sessionRepository.deleteByUserAndRoom(userId, roomId);
    }

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

    // Normalize wire format. Whether the response is the new
    // `{ devices: [...] }` shape or the legacy single bundle, we end up
    // with the same canonical `userId → Set<deviceId>` mapping and a
    // single normalized bundle to return (callers downstream of this
    // method read fields like `identityPublicKey` directly).
    const bundles = this.bundlesFromResponse(remoteKeys);
    const deviceIds = bundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);
    this.updateRemoteDeviceMap(remoteUserId, deviceIds);

    if (bundles.length === 0) return remoteKeys;
    return bundles[0];
  }

  /**
   * Multi-device variant of `fetchRemoteKeys`: returns the full list of
   * per-device bundles published by `remoteUserId`. Used by the fan-out
   * send path that needs to establish one session per peer device.
   *
   * Also refreshes the multi-device cache as a side effect.
   */
  async fetchAllRemoteBundles(roomId: number, remoteUserId: string): Promise<any[]> {
    const api = this.getApiForRoom(roomId);
    const remoteKeys = await api.getRemoteKeys(remoteUserId);
    if (!remoteKeys) return [];

    const bundles = this.bundlesFromResponse(remoteKeys);
    const deviceIds = bundles
      .map((b) => Number(b.deviceId ?? PRIMARY_DEVICE_ID))
      .filter((n) => Number.isFinite(n) && n > 0);
    this.updateRemoteDeviceMap(remoteUserId, deviceIds);

    return bundles;
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
