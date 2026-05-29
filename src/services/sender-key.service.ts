import SignalProtocol from 'signal-protocol';
import { serverRegistry } from './server-registry';
import { sessionService } from './session.service';
import { senderKeyRepository } from '@/db/repositories/sender-key.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { useAuthStore } from '@/stores/auth.store';
import {
  PRIMARY_DEVICE_ID,
  SENDER_KEY_THRESHOLD,
  SENDER_KEY_MESSAGE_ROTATION_THRESHOLD,
  SENDER_KEY_ROTATION_THRESHOLD_SECONDS,
} from '@/config/app.config';
import { logger } from '@/utils/logger';
import { toBackendRoomId } from '@/utils/server-id';

/**
 * Recipient of a sender-key distribution. Accepts both legacy (number =
 * userId, fan-out to every cached device) and explicit (`{userId, deviceId}`)
 * forms so callers can either redistribute to a whole user (member joins
 * a room) or to a specific linked device (primary → its own new device
 * after `deviceLinked`).
 */
export type SenderKeyTarget = number | { userId: number; deviceId?: number };

class SenderKeyService {
  private getOwnUserId(): number | null {
    return useAuthStore.getState().userId;
  }

  private getApiForRoom(roomId: number) {
    return serverRegistry.getApiForRoom(roomId);
  }

  async shouldUseSenderKeys(roomId: number): Promise<boolean> {
    const room = await roomRepository.findById(roomId);
    return room?.useSenderKeys === 1;
  }

  async hasSenderKeySession(roomId: number, senderUserId: number): Promise<boolean> {
    const session = await senderKeyRepository.findSessionByRoomAndSender(roomId, senderUserId);
    return !!session;
  }

  async initializeSenderKeys(roomId: number, memberIds: number[]): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) throw new Error('Missing sender user id');

    logger.info('[SenderKey] Initializing for room', roomId, 'members:', memberIds.length);

    try {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);

      const initRes = await api.post(`sender-keys/initialize/${backendRoomId}`, {}) as { distributionId: string };
      const distributionId = initRes.distributionId;

      const { distributionMessage } = await SignalProtocol.createSenderKeySession(String(roomId), distributionId);

      await senderKeyRepository.upsertSession({
        idRoom: roomId,
        senderUserId,
        distributionId,
        chainVersion: 1,
        messageCount: 0,
      });

      await this.distributeSenderKey(roomId, distributionId, distributionMessage, memberIds);

      await roomRepository.update(roomId, { useSenderKeys: 1 });

      logger.info('[SenderKey] Initialized successfully');
    } catch (error) {
      logger.error('[SenderKey] Initialization failed:', error);
      throw error;
    }
  }

  async initializeSenderKeysIfNeeded(roomId: number): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) return;

    const hasSession = await this.hasSenderKeySession(roomId, senderUserId);
    if (hasSession) return;

    try {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);
      const members = await api.getRoomMembers(backendRoomId);
      const totalMembers = (members?.length || 0) + 1;

      if (totalMembers >= SENDER_KEY_THRESHOLD) {
        const memberIds = members
          .map((m: any) => m.id_user)
          .filter((id: number) => id !== senderUserId);

        await this.initializeSenderKeys(roomId, memberIds);
      }
    } catch (error) {
      logger.error('[SenderKey] initializeSenderKeysIfNeeded failed:', error);
    }
  }

  /**
   * Build `(userId, deviceId)` targets from a polymorphic member list.
   *
   * - `number` (legacy): expand to every cached device id for that user
   *   via `sessionService.getRemoteDeviceIds`. Fall back to
   *   `[PRIMARY_DEVICE_ID]` when the cache is empty so single-device peers
   *   still receive a distribution.
   * - `{ userId, deviceId }`: target exactly that device. Used for
   *   `deviceLinked` self-redistribution (primary → own new linked device)
   *   and any caller that already knows the precise destination.
   * - `{ userId }` without `deviceId`: expand exactly like the legacy form.
   */
  private expandTargets(members: SenderKeyTarget[]): Array<{ userId: number; deviceId: number }> {
    const out: Array<{ userId: number; deviceId: number }> = [];
    for (const m of members) {
      if (typeof m === 'number') {
        const devices = this.devicesForUser(m);
        for (const d of devices) out.push({ userId: m, deviceId: d });
      } else if (typeof m.deviceId === 'number') {
        out.push({ userId: m.userId, deviceId: m.deviceId });
      } else {
        const devices = this.devicesForUser(m.userId);
        for (const d of devices) out.push({ userId: m.userId, deviceId: d });
      }
    }
    return out;
  }

  private devicesForUser(userId: number): number[] {
    const cached = sessionService.getRemoteDeviceIds(String(userId));
    return cached.length > 0 ? cached : [PRIMARY_DEVICE_ID];
  }

  private async distributeSenderKey(
    roomId: number,
    distributionId: string,
    distributionMessage: string,
    members: SenderKeyTarget[]
  ): Promise<void> {
    const distributions: Array<{ recipientUserId: number; recipientDeviceId: number; encryptedSenderKey: string }> = [];
    const failedMembers = new Set<number>();
    const targets = this.expandTargets(members);

    const senderUserId = this.getOwnUserId();

    for (const { userId, deviceId } of targets) {
      try {
        if (senderUserId != null && userId === senderUserId) {
          // Self-fan-out: distributing the sender key to one of OUR OWN
          // linked devices (Fase C, post `deviceLinked`). The normal
          // `ensureSession` blocks self-targets — use the dedicated path.
          const ok = await sessionService.ensureSessionForOwnLinkedDevice(roomId, userId, deviceId);
          if (!ok) {
            logger.warn(`[SenderKey] Skipping self-linked target ${userId}/${deviceId}: session not ready`);
            continue;
          }
        } else {
          await sessionService.ensureSession(roomId, userId);
        }

        const { encryptedMessage } = await SignalProtocol.encryptMessage(
          encodeURIComponent(distributionMessage),
          String(userId),
          deviceId,
        );

        distributions.push({
          recipientUserId: userId,
          recipientDeviceId: deviceId,
          encryptedSenderKey: encryptedMessage,
        });

        await this.removeFailedDistribution(roomId, userId);
      } catch (error) {
        logger.error(`[SenderKey] Failed to encrypt for ${userId}/${deviceId}:`, error);
        failedMembers.add(userId);
        await this.trackFailedDistribution(roomId, userId, distributionId);
      }
    }

    if (distributions.length > 0) {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);
      await api.uploadSenderKeyDistribution(backendRoomId, distributionId, distributions);
      logger.info(`[SenderKey] Distributed to ${distributions.length} (userId,deviceId) targets`);
    }

    if (failedMembers.size > 0) {
      logger.warn(`[SenderKey] Failed for ${failedMembers.size} members:`, Array.from(failedMembers));
    }
  }

  async fetchAndProcessPendingSenderKeys(roomId: number): Promise<void> {
    logger.info('[SenderKey] Fetching pending for room', roomId);

    try {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);
      const res = await api.fetchPendingSenderKeys(backendRoomId);
      const distributions = res.distributions || [];
      const processedIds: number[] = [];

      for (const dist of distributions) {
        try {
          const decrypted = await SignalProtocol.decryptMessage(
            dist.encryptedSenderKey,
            String(dist.senderUserId),
          );

          const distributionMessage = decodeURIComponent(decrypted.message);

          await SignalProtocol.processSenderKeyDistribution(
            String(roomId),
            String(dist.senderUserId),
            distributionMessage,
            typeof dist.senderDeviceId === 'number' ? dist.senderDeviceId : null,
          );

          await senderKeyRepository.upsertSession({
            idRoom: roomId,
            senderUserId: dist.senderUserId,
            distributionId: dist.distributionId,
            chainVersion: 1,
            messageCount: 0,
          });

          processedIds.push(dist.id);
          logger.info('[SenderKey] Processed from user', dist.senderUserId);
        } catch (error) {
          logger.error(`[SenderKey] Failed to process distribution ${dist.id}:`, error);
        }
      }

      if (processedIds.length > 0) {
        await api.put('sender-keys/mark-delivered', {
          distributionIds: processedIds,
        });
      }

      logger.info(`[SenderKey] Processed ${processedIds.length} distributions`);

      if (processedIds.length > 0) {
        await roomRepository.update(roomId, { useSenderKeys: 1 });
        const { useChatStore } = await import('@/stores/chat.store');
        useChatStore.getState().updateRoomInList(roomId, { useSenderKeys: 1 });
        logger.info(`[SenderKey] Enabled sender keys for room ${roomId}`);

        await this.initializeSenderKeysIfNeeded(roomId);
      }
    } catch (error) {
      logger.error('[SenderKey] fetchAndProcessPendingSenderKeys failed:', error);
    }
  }

  async encryptWithSenderKey(
    roomId: number,
    plaintext: string
  ): Promise<{ ciphertext: string; distributionId: string }> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) throw new Error('Missing sender user id');

    const session = await senderKeyRepository.findSessionByRoomAndSender(roomId, senderUserId);
    if (!session?.distributionId) {
      throw new Error('No sender key session for room');
    }

    if (await this.shouldRotateSenderKey(roomId)) {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);
      const members = await api.getRoomMembers(backendRoomId);
      const memberIds = members.map((m: any) => m.id_user).filter((id: number) => id !== senderUserId);
      await this.rotateSenderKey(roomId, memberIds);
    }

    const { ciphertext } = await SignalProtocol.encryptGroupMessage(
      plaintext,
      String(roomId),
      session.distributionId,
    );

    await senderKeyRepository.incrementMessageCount(session.id);

    return { ciphertext, distributionId: session.distributionId };
  }

  async decryptWithSenderKey(
    roomId: number,
    senderUserId: number,
    ciphertext: string,
    senderDeviceId?: number | null
  ): Promise<string> {
    const { message } = await SignalProtocol.decryptGroupMessage(
      ciphertext,
      String(roomId),
      String(senderUserId),
      senderDeviceId ?? null,
    );

    return message;
  }

  async rotateSenderKey(roomId: number, memberIds: number[]): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) throw new Error('Missing sender user id');

    logger.info('[SenderKey] Rotating for room', roomId);

    const api = this.getApiForRoom(roomId);
    const backendRoomId = toBackendRoomId(roomId);
    const rotateRes = await api.post(`sender-keys/rotate/${backendRoomId}`, {}) as { distributionId: string };
    const newDistributionId = rotateRes.distributionId;

    const { distributionMessage } = await SignalProtocol.rotateSenderKey(String(roomId));

    await this.distributeSenderKey(roomId, newDistributionId, distributionMessage, memberIds);

    const existing = await senderKeyRepository.findSessionByRoomAndSender(roomId, senderUserId);
    if (existing) {
      await senderKeyRepository.updateChainVersion(existing.id, (existing.chainVersion || 0) + 1);
    }

    logger.info('[SenderKey] Rotated successfully');
  }

  async shouldRotateSenderKey(roomId: number): Promise<boolean> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) return false;

    const session = await senderKeyRepository.findSessionByRoomAndSender(roomId, senderUserId);
    if (!session) return false;

    if ((session.messageCount || 0) >= SENDER_KEY_MESSAGE_ROTATION_THRESHOLD) return true;

    const secondsSinceCreation = (Date.now() / 1000 - (session.created || 0));
    return secondsSinceCreation >= SENDER_KEY_ROTATION_THRESHOLD_SECONDS;
  }

  async handleMemberLeft(roomId: number): Promise<void> {
    const useSenderKeys = await this.shouldUseSenderKeys(roomId);
    if (!useSenderKeys) return;

    try {
      const api = this.getApiForRoom(roomId);
      const backendRoomId = toBackendRoomId(roomId);
      const members = await api.getRoomMembers(backendRoomId);
      const senderUserId = this.getOwnUserId();
      const memberIds = members
        .map((m: any) => m.id_user)
        .filter((id: number) => id !== senderUserId);

      await this.rotateSenderKey(roomId, memberIds);
    } catch (error) {
      logger.error('[SenderKey] handleMemberLeft rotation failed:', error);
    }
  }

  /**
   * Redistribute the existing sender-key state to one or more new targets.
   *
   * Two usage shapes:
   *  - `number[]` (legacy): list of userIds joining the room. Each one is
   *    expanded to every cached device.
   *  - `Array<{ userId, deviceId? }>`: explicit targets. Use the object
   *    form with a concrete `deviceId` for the post-pairing flow where the
   *    primary redistributes only to its own brand-new linked device.
   */
  async redistributeToNewMembers(roomId: number, newMembers: SenderKeyTarget[]): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) return;

    const session = await senderKeyRepository.findSessionByRoomAndSender(roomId, senderUserId);
    if (!session?.distributionId) {
      logger.info('[SenderKey] No existing session, skipping redistribution for room', roomId);
      return;
    }

    logger.info('[SenderKey] Redistributing to new members:', newMembers, 'room:', roomId);

    try {
      const { distributionMessage } = await SignalProtocol.createSenderKeySession(
        String(roomId),
        session.distributionId
      );

      await this.distributeSenderKey(roomId, session.distributionId, distributionMessage, newMembers);

      logger.info('[SenderKey] Redistributed to', newMembers.length, 'new targets');
    } catch (error) {
      logger.error('[SenderKey] redistributeToNewMembers failed:', error);
    }
  }

  // ========================================
  // RETRY QUEUE
  // ========================================

  private async trackFailedDistribution(
    roomId: number,
    recipientUserId: number,
    distributionId: string
  ): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) return;

    try {
      await senderKeyRepository.addToRetryQueue({
        roomId,
        senderUserId,
        recipientUserId,
        distributionId,
      });
    } catch (error) {
      logger.error('[SenderKey] trackFailedDistribution error:', error);
    }
  }

  private async removeFailedDistribution(roomId: number, recipientUserId: number): Promise<void> {
    const senderUserId = this.getOwnUserId();
    if (!senderUserId) return;

    try {
      const item = await senderKeyRepository.findRetryQueueItem(
        roomId,
        senderUserId,
        recipientUserId
      );
      if (item) {
        await senderKeyRepository.removeFromRetryQueue(item.id);
      }
    } catch (error) {
      // Ignore
    }
  }
}

export const senderKeyService = new SenderKeyService();
export default senderKeyService;
