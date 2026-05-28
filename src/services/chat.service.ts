import SignalProtocol from 'signal-protocol';
import * as Haptics from 'expo-haptics';
import { SocketConnectionState } from '@/types/connection';
import { serverRegistry } from './server-registry';
import type { SocketService, SendMessageAck, SendMessageMetadata, PacketRecipientFanout } from './socket.service';
import { sessionService } from './session.service';
import { senderKeyService } from './sender-key.service';
import { queueService } from './queue.service';
import { messageRepository } from '@/db/repositories/message.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { profileRepository } from '@/db/repositories/profile.repository';
import { sessionRepository } from '@/db/repositories/session.repository';
import { senderKeyRepository } from '@/db/repositories/sender-key.repository';
import { useChatStore } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { useAppStore } from '@/stores/app.store';
import { useServerStore } from '@/stores/server.store';
import {
  MessageEnvelope,
  MessageEnvelopeFactory,
  UserMessageType,
  UserMessageTypeValue,
  ControlPacketType,
  ControlPacketTypeValue,
  MessageStatus,
  ImageMessagePayload,
  PersistentImagePayload,
  EphemeralImagePayload,
  FileMessagePayload,
  SendResult,
  MessageStatusType,
} from '@/types/message';
import { mediaCryptoService } from './media-crypto.service';
import { Message, NewMessage } from '@/db/schema';
import { generateUUID, generateLocalId } from '@/types/message';
import {PAGE_SIZE, PRIMARY_DEVICE_ID, SENDER_KEY_THRESHOLD, TYPING_THROTTLE_MS} from '@/config/app.config';
import { logger } from '@/utils/logger';
import { generateThumbnailFromBase64, generateMicroThumbnailFromBase64, generateColorPreviewFromBase64, saveImageToFile, deleteImagesByMessageIds, readImageAsBase64 } from '@/utils/image';
import { readFileAsBase64, saveFileToCache, deleteFilesByMessageIds, fileExists, resolveFilePath, MAX_FILE_SIZE } from '@/utils/file';
import { toLocalRoomId, toBackendRoomId, getServerIdFromRoomId } from '@/utils/server-id';

class ChatService {
  private initialized = false;
  private connectingLocks = new Set<number>(); // per-server lock
  private unsubscribes: (() => void)[] = [];

  // In-memory dedup: prevents concurrent processing of the same message
  private processingMessages = new Set<string>();

  // Rate limiting for incoming typing indicators (per roomId:userId)
  private typingReceiveThrottle = new Map<string, number>();

  // Serial message queue: prevents concurrent Signal Protocol operations
  private messageQueue: Promise<void> = Promise.resolve();
  private enqueueSignalOperation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.messageQueue = this.messageQueue
        .then(() => operation().then(resolve, reject))
        .catch((error) => {
          logger.error('[ChatService] enqueueSignalOperation queue error:', error);
          reject(error);
        });
    });
  }

  // Typing indicator throttle: roomId -> last typing_start sent timestamp.
  // Deliberately NOT cleared on typing_stop (frontend-0015 D) so the next
  // keystroke cannot instantly re-arm a fresh typing_start.
  private typingThrottleMap = new Map<number, number>();
  // Rooms where we have announced typing and not yet sent a stop — so a
  // typing_stop is emitted at most once per typing burst.
  private typingActiveRooms = new Set<number>();

  // ========================================
  // INITIALIZATION
  // ========================================

  /**
   * Initialize chat service: attach socket handlers on ALL servers and start queue.
   */
  init(): void {
    // Cleanup existing handlers
    this.unsubscribes.forEach((fn) => fn());
    this.unsubscribes = [];

    // Clear all socket service handlers to prevent accumulation
    for (const server of serverRegistry.getAllServers()) {
      const socket = serverRegistry.getSocket(server.id);
      socket.clearAllServiceHandlers();
    }

    // Register handlers on each server's socket
    for (const server of serverRegistry.getAllServers()) {
      this.registerSocketHandlers(server.id);
    }

    if (!this.initialized) {
      // Configure queue send function (only once)
      queueService.setSendFunction(async (envelope) => {
        const socket = serverRegistry.getSocketForRoom(envelope.id_room);
        const backendRoomId = toBackendRoomId(envelope.id_room);
        return this.emitSendMessage(
          socket,
          backendRoomId,
          envelope,
          envelope.category,
          envelope.type
        );
      });

      queueService.startProcessor();
    }

    this.initialized = true;
    logger.info('[ChatService] Initialized');
  }

  /**
   * Register socket handlers when a new server is added after init.
   */
  registerSocketHandlers(serverId: number): void {
    const socket = serverRegistry.getSocket(serverId);

    const unsub1 = socket.onMessage(async (envelope) => {
      // envelope.id_room may contain the sender's local room ID (with their server offset).
      // Extract the backend room ID first, then apply the receiver's server offset.
      envelope.id_room = toLocalRoomId(serverId, toBackendRoomId(envelope.id_room));
      await this.handleIncomingMessage(envelope);
    });

    const unsub2 = socket.onPacket(async (envelope) => {
      envelope.id_room = toLocalRoomId(serverId, toBackendRoomId(envelope.id_room));
      await this.handleIncomingMessage(envelope);
    });

    const unsub3 = socket.onStateChange(async (state) => {
      // Update per-server connection state in store
      useServerStore.getState().setConnectionState(serverId, state);

      if (state === SocketConnectionState.CONNECTED) {
        logger.info(`[ChatService] Server ${serverId} connected - processing pending & joining rooms`);
        await this.onConnected(serverId);
      }
    });

    const unsub4 = socket.onSenderKeysAvailable(async (data: { roomId: number; senderUserId: number; distributionId: string }) => {
      const localRoomId = toLocalRoomId(serverId, toBackendRoomId(data.roomId));
      logger.info('[ChatService] Sender keys available notification:', localRoomId, 'from:', data.senderUserId);
      try {
        await this.enqueueSignalOperation(() => senderKeyService.fetchAndProcessPendingSenderKeys(localRoomId));
      } catch (error) {
        logger.error('[ChatService] Failed to process sender keys notification:', error);
      }
    });

    const unsub5 = socket.onRoomDeleted(async (data) => {
      const localRoomId = toLocalRoomId(serverId, data.roomId);
      logger.info('[ChatService] roomDeleted event for room', localRoomId, 'by', data.deletedBy);
      await this.performLocalRoomCleanup(localRoomId);
    });

    const unsub6 = socket.onUserLeftRoom(async (data) => {
      const localRoomId = toLocalRoomId(serverId, data.roomId);
      logger.info('[ChatService] userLeftRoom event for room', localRoomId, 'user', data.userId);
      await this.handleUserLeftRoom(localRoomId, data.userId);
    });

    // Multi-device pairing/revocation events. We only wire these on the
    // default server: linked-device state is user-level (not room-level),
    // and `device.store` / `deviceService` operate against the default
    // server (where the user's identity lives).
    const isDefaultServer = serverId === serverRegistry.getDefaultServerId();
    const unsub7 = isDefaultServer
      ? socket.onDeviceLinked(async (data) => {
          logger.info('[ChatService] deviceLinked event — refreshing devices + redistributing sender keys to device', data.deviceId);
          try {
            // Lazy import to avoid a require cycle device.service → chat.service.
            const { deviceService } = await import('./device.service');
            await deviceService.loadDevices();
          } catch (err) {
            logger.warn('[ChatService] onDeviceLinked: loadDevices failed:', err);
          }

          // Self deviceMap: invalidate and eagerly re-fetch so the freshly
          // linked own device enters the self-fanout cache without waiting
          // for the next onConnected sync. Without this the very next send
          // would still encrypt only for the device list known before the
          // link, and the new device would not receive a copy.
          const ownUserIdForServer = serverRegistry.getUserIdForServer(serverId);
          if (ownUserIdForServer != null) {
            const ownKey = String(ownUserIdForServer);
            sessionService.invalidateRemoteDeviceMap(ownKey);
            try {
              const ownUserIdForRooms = useAuthStore.getState().userId;
              const rooms = ownUserIdForRooms != null
                ? await roomRepository.findAllWithMetadata(ownUserIdForRooms)
                : [];
              const sharedRoom = rooms.find((r: any) => r?.serverId === serverId);
              if (sharedRoom) {
                await sessionService.refreshRemoteDeviceMap(sharedRoom.id, ownKey, { force: true });
              }
            } catch (err) {
              logger.warn('[ChatService] deviceLinked: self deviceMap refresh failed:', err);
            }
          }

          // Fase C: redistribute sender-key state to the new linked device
          // for every group room where we are the sender. The redistribution
          // creates one (encrypted) distribution message addressed to
          // `(ownUserId, newDeviceId)`. After this the new device can decrypt
          // future group messages from us. The peer-fan-out path handled in
          // chat.service.encrypt() picks up the new device id from the next
          // /keys/:userId refresh on the other clients.
          const ownUserId = useAuthStore.getState().userId;
          if (ownUserId == null) {
            logger.warn('[ChatService] deviceLinked: no ownUserId, skipping sender-key redistribution');
            return;
          }
          const senderKeyRooms = useChatStore
            .getState()
            .allRooms.filter((r: any) => r?.useSenderKeys === 1);
          if (senderKeyRooms.length === 0) {
            logger.info('[ChatService] deviceLinked: no group rooms, nothing to redistribute');
            return;
          }
          logger.info(`[ChatService] deviceLinked: redistributing for ${senderKeyRooms.length} group room(s) to device ${data.deviceId}`);
          for (const room of senderKeyRooms) {
            try {
              await senderKeyService.redistributeToNewMembers(room.id, [
                { userId: ownUserId, deviceId: data.deviceId },
              ]);
            } catch (err) {
              logger.warn('[ChatService] deviceLinked: redistribute failed for room', room.id, err);
            }
          }
        })
      : () => undefined;

    const unsub8 = isDefaultServer
      ? socket.onDeviceRevoked(async (data) => {
          if (data.self) {
            logger.warn('[ChatService] deviceRevoked self=true — forcing logout');
            const { appInitService } = await import('./app-init.service');
            await appInitService.logout();
            return;
          }
          // Peer revoked one of their devices — drop the local libsignal
          // session for that (userId, revokedDeviceId) so we stop trying
          // to encrypt for it. The fan-out send path (Fase D) will pick
          // up the change via the next /keys/:userId refresh.
          try {
            await SignalProtocol.deleteRemoteSession(String(data.userId), data.revokedDeviceId);
            logger.info('[ChatService] deviceRevoked peer session dropped', data.userId, data.revokedDeviceId);
          } catch (err) {
            logger.warn('[ChatService] deleteRemoteSession failed:', err);
          }
          // Also refresh our own device list in case the server piggybacked
          // an update (no-op if nothing changed).
          try {
            const { deviceService } = await import('./device.service');
            await deviceService.loadDevices();
          } catch {
            // non-fatal
          }
        })
      : () => undefined;

    // peerDeviceLinked: a user with whom we share a room added a new device.
    // Invalidate the cached deviceMap for that user and refresh eagerly so
    // the very next outgoing message includes a ciphertext for the new
    // device. Spec: _shared/api/peer-device-linked.md.
    const unsub9 = socket.onPeerDeviceLinked(async (data) => {
      const userIdStr = String(data.userId);
      logger.info('[ChatService] peerDeviceLinked event for user', userIdStr, 'addedDeviceId:', data.addedDeviceId);
      sessionService.invalidateRemoteDeviceMap(userIdStr);
      // Eager refresh: find any room shared with this peer so
      // refreshRemoteDeviceMap has a serverId to route the API call. If
      // none is found locally, skip — the next fan-out send for this peer
      // will lazily refresh through the encrypt path.
      try {
        const ownUserId = useAuthStore.getState().userId;
        if (ownUserId == null) return;
        const rooms = await roomRepository.findAllWithMetadata(ownUserId);
        const sharedRoom = rooms.find((r: any) => r?.serverId === serverId);
        if (!sharedRoom) return;
        await sessionService.refreshRemoteDeviceMap(sharedRoom.id, userIdStr, { force: true });
      } catch (err) {
        logger.warn('[ChatService] peerDeviceLinked: eager refresh failed:', err);
      }
    });

    this.unsubscribes.push(unsub1, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7, unsub8, unsub9);
  }

  /**
   * Cleanup on logout
   */
  destroy(): void {
    this.unsubscribes.forEach((fn) => fn());
    this.unsubscribes = [];
    queueService.stopProcessor();
    queueService.clearQueue();
    this.initialized = false;
    this.connectingLocks.clear();
    this.messageQueue = Promise.resolve();
    this.processingMessages.clear();
    logger.info('[ChatService] Destroyed');
  }

  /**
   * Called when a specific server's socket connects.
   */
  private async onConnected(serverId: number): Promise<void> {
    if (this.connectingLocks.has(serverId)) return;
    this.connectingLocks.add(serverId);

    try {
      logger.info(`[ChatService] onConnected(${serverId}): starting sync...`);

      // 1. Sync rooms from backend
      await this.syncAllRoomsFromBackend(serverId).catch((error) => {
        logger.warn(`[ChatService] syncAllRoomsFromBackend(${serverId}) error:`, error);
      });

      // 2. Sync room members and establish sessions
      await this.syncRoomMembersAndSessions(serverId).catch((error) => {
        logger.warn(`[ChatService] syncRoomMembersAndSessions(${serverId}) error:`, error);
      });

      // 2b. Load all room profiles into store (needed for room list display names)
      await this.loadAllRoomProfiles().catch((error) => {
        logger.warn(`[ChatService] loadAllRoomProfiles error:`, error);
      });

      // 3. Process pending message queue
      await queueService.forceProcess();

      // 4. Fetch pending sender keys for all rooms on this server
      await this.enqueueSignalOperation(() => this.fetchPendingSenderKeysForServer(serverId)).catch((error) => {
        logger.warn(`[ChatService] fetchPendingSenderKeysForServer(${serverId}) error:`, error);
      });

      // 5. Refresh pre-keys for this server
      await sessionService.refreshPreKeysIfNeeded(serverId);

      // 6. Retry stuck sending messages
      await this.retrySendingMessages().catch((error) => {
        logger.warn('[ChatService] retrySendingMessages error:', error);
      });

      logger.info(`[ChatService] onConnected(${serverId}): sync complete`);
    } catch (error) {
      logger.error(`[ChatService] onConnected(${serverId}) error:`, error);
    } finally {
      this.connectingLocks.delete(serverId);
    }
  }

  /**
   * Sync all rooms from a specific server's backend API.
   */
  async syncAllRoomsFromBackend(serverId: number): Promise<void> {
    const api = serverRegistry.getApi(serverId);
    logger.info(`[ChatService] syncAllRoomsFromBackend(${serverId}): fetching rooms from API...`);

    try {
      const response = await api.getAllRooms();
      const backendRooms = response?.rooms ?? [];

      logger.info(`[ChatService] syncAllRoomsFromBackend(${serverId}): got`, backendRooms.length, 'rooms from backend');

      // Build set of backend local IDs for orphan detection
      const backendLocalIds = new Set<number>();

      for (const roomData of backendRooms) {
        try {
          const localId = toLocalRoomId(serverId, roomData.id);
          backendLocalIds.add(localId);
          await roomRepository.upsert({
            id: localId,
            name: roomData.name,
            inviteCode: roomData.inviteCode,
            status: roomData.status ?? 0,
            idUser: roomData.idUser,
            useSenderKeys: roomData.useSenderKeys ? 1 : 0,
            administered: roomData.administered ? 1 : 0,
            serverId,
          });
        } catch (error) {
          logger.warn(`[ChatService] syncAllRoomsFromBackend(${serverId}): failed to upsert room`, roomData.id, error);
        }
      }

      // Cleanup orphan rooms: local rooms no longer present on the backend
      try {
        const localRooms = await roomRepository.findByServerId(serverId);
        let orphanCount = 0;
        for (const localRoom of localRooms) {
          if (!backendLocalIds.has(localRoom.id)) {
            logger.info(`[ChatService] syncAllRoomsFromBackend(${serverId}): removing orphan room`, localRoom.id);
            await this.performLocalRoomCleanup(localRoom.id);
            orphanCount++;
          }
        }
        if (orphanCount > 0) {
          logger.info(`[ChatService] syncAllRoomsFromBackend(${serverId}): removed`, orphanCount, 'orphan rooms');
        }
      } catch (error) {
        logger.warn(`[ChatService] syncAllRoomsFromBackend(${serverId}): orphan cleanup error:`, error);
      }

      await this.loadRooms();
    } catch (error) {
      logger.error(`[ChatService] syncAllRoomsFromBackend(${serverId}) error:`, error);
    }
  }

  /**
   * Sync room members and establish sessions (scoped to a server).
   */
  async syncRoomMembersAndSessions(serverId: number): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) return;

    const api = serverRegistry.getApi(serverId);
    const rooms = await roomRepository.findAllWithMetadata(userId);
    const serverRooms = rooms.filter((r) => r.serverId === serverId);

    logger.info(`[ChatService] syncRoomMembersAndSessions(${serverId}): checking`, serverRooms.length, 'rooms');

    const serverUserId = serverRegistry.getUserIdForServer(serverId);

    // Track peers whose device map we've already refreshed during this sync,
    // so a peer present in N shared rooms still triggers only one
    // /keys/:userId fetch per onConnected (the throttle inside
    // refreshRemoteDeviceMap is a per-userId backstop on a longer horizon).
    const refreshedDeviceMapFor = new Set<string>();

    // Self device map: GET /chat/:id/members filters the requester out, so the
    // per-member refresh below never covers OUR own user — the result is an
    // empty `deviceMap[ownUserId]` and a silent skip of the self-fanout loop
    // in encrypt() (so our own linked devices never receive a copy of what we
    // send). Force-refresh once per sync for the server's own user, using any
    // room on this server as a routing hint for the API call. Detached on
    // purpose: a refresh failure must not stall the per-room session work.
    if (serverUserId != null && serverRooms.length > 0) {
      const ownKey = String(serverUserId);
      refreshedDeviceMapFor.add(ownKey);
      sessionService
        .refreshRemoteDeviceMap(serverRooms[0].id, ownKey, { force: true })
        .catch((err) => {
          logger.warn(`[ChatService] syncRoomMembersAndSessions(${serverId}): self deviceMap refresh failed`, err);
        });
    }

    for (const room of serverRooms) {
      try {
        const backendRoomId = toBackendRoomId(room.id);
        const members = await api.getRoomMembers(backendRoomId);

        for (const member of members) {
          // Skip self — check both global and server-specific user ID
          if (member.id_user === userId || member.id_user === serverUserId) continue;

          const memberKey = String(member.id_user);
          const existingSession = await sessionRepository.findByUserAndRoom(
            memberKey,
            room.id
          );

          if (!existingSession) {
            logger.info(`[ChatService] syncRoomMembersAndSessions(${serverId}): new member found in room`, room.id, '- establishing session with', member.id_user);

            try {
              await this.enqueueSignalOperation(async () => {
                const success = await sessionService.setSession(
                  room.id,
                  member.id_user,
                  member.username || `user-${member.id_user}`,
                  1
                );

                if (success) {
                  useChatStore.getState().updateRoomInList(room.id, { hasSession: true });

                  if (room.useSenderKeys === 1) {
                    try {
                      await senderKeyService.redistributeToNewMembers(room.id, [member.id_user]);
                    } catch (skError) {
                      logger.warn('[ChatService] syncRoomMembersAndSessions: sender key redistribution failed for', member.id_user, skError);
                    }
                  }
                }
              });
              // setSession's success path already populated the device map
              // via the full /keys fetch — mark it so we don't refetch.
              refreshedDeviceMapFor.add(memberKey);
            } catch (sessionError) {
              logger.warn('[ChatService] syncRoomMembersAndSessions: failed to establish session with', member.id_user, sessionError);
            }
          } else if (!refreshedDeviceMapFor.has(memberKey)) {
            // Peer with an existing session: setSession() takes an early
            // resume branch and skips the /keys refresh. Without this
            // explicit refresh, newly-linked peer devices would never be
            // discovered until the next first-contact in some other room
            // (frontend-0008).
            refreshedDeviceMapFor.add(memberKey);
            sessionService.refreshRemoteDeviceMap(room.id, memberKey).catch((err) => {
              logger.warn('[ChatService] syncRoomMembersAndSessions: device map refresh failed for', member.id_user, err);
            });
          }

          await profileRepository.upsert({
            idUser: member.id_user,
            idRoom: room.id,
            username: member.username || `user-${member.id_user}`,
          });
        }
      } catch (error) {
        logger.warn(`[ChatService] syncRoomMembersAndSessions(${serverId}): failed for room`, room.id, error);
      }
    }
  }

  /**
   * Fetch and process pending sender keys for all rooms on a specific server.
   */
  async fetchPendingSenderKeysForServer(serverId: number): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) return;

    const rooms = await roomRepository.findAllWithMetadata(userId);
    const serverRooms = rooms.filter((r) => r.serverId === serverId);

    for (const room of serverRooms) {
      try {
        await senderKeyService.initializeSenderKeysIfNeeded(room.id);
      } catch (error) {
        logger.warn('[ChatService] initializeSenderKeysIfNeeded failed for room', room.id, error);
      }

      if (room.useSenderKeys) {
        try {
          logger.info('[ChatService] Fetching pending sender keys for room', room.id);
          await senderKeyService.fetchAndProcessPendingSenderKeys(room.id);
        } catch (error) {
          logger.warn('[ChatService] fetchPendingSenderKeys failed for room', room.id, error);
        }
      }
    }
  }

  // ========================================
  // MESSAGE ROUTING
  // ========================================

  async handleIncomingMessage(envelope: MessageEnvelope): Promise<void> {
    const userId = useAuthStore.getState().userId;
    const ownDeviceId = useAuthStore.getState().deviceId ?? PRIMARY_DEVICE_ID;
    // Also check server-specific user ID (different per server)
    const serverUserId = serverRegistry.getUserIdForRoom(envelope.id_room);

    // A6: normalize device_id_from at the boundary. Legacy envelopes queued
    // in pending_messages and some backend code paths can deliver this as
    // a string (e.g. "1" instead of 1). The self-fanout echo filter below
    // gates on `typeof === 'number'` and would let a stringified own-device
    // echo through; downstream native calls expect a number. Coerce once
    // here so every consumer downstream is guaranteed `number | undefined`,
    // without each call site re-running the same defensive guard.
    const rawDeviceIdFrom = (envelope as any).device_id_from;
    if (rawDeviceIdFrom != null && typeof rawDeviceIdFrom !== 'number') {
      const coerced = Number(rawDeviceIdFrom);
      if (Number.isFinite(coerced) && coerced > 0) {
        envelope.device_id_from = coerced;
      } else {
        delete envelope.device_id_from;
      }
    }

    // Multi-device: a message with `id_user_from === self` may come from
    // ANOTHER linked device of ours (self-fan-out copy — see the self-fanout
    // loop in `encrypt`). Drop only when `device_id_from` is EXPLICITLY set
    // and matches our own deviceId — a strict echo of what we sent. When
    // `device_id_from` is missing on the wire we cannot tell a true echo
    // apart from a self-fanout copy authored by another linked device, and
    // defaulting to PRIMARY_DEVICE_ID would silently drop legitimate
    // self-fanouts on the primary (the very symptom this guard tries to
    // prevent). Downstream dedup (`messageRepository.findById` /
    // `processingMessages`) catches real echos that slip through.
    const isOwnUser = envelope.id_user_from === userId || envelope.id_user_from === serverUserId;
    const hasSenderDeviceId = typeof envelope.device_id_from === 'number';
    const isOwnEcho = isOwnUser && hasSenderDeviceId && envelope.device_id_from === ownDeviceId;
    if (envelope.category !== 'system' && isOwnEcho) {
      logger.info('[ChatService] Skipping own echo:', envelope.id, 'category:', envelope.category, 'device:', envelope.device_id_from);
      return;
    }

    // Hard cap on payload size. Anything bigger than this is dropped before
    // hitting the serial messageQueue — otherwise a malicious server could
    // stall encrypt/decrypt for everyone by sending one giant envelope.
    // 256 KB is well above any legitimate E2EE payload (text < 10KB, image
    // metadata < 1KB, sender-key distribution < 2KB).
    const MAX_PAYLOAD_BYTES = 256 * 1024;
    try {
      const payloadSize = JSON.stringify(envelope.payload ?? null).length;
      if (payloadSize > MAX_PAYLOAD_BYTES) {
        logger.warn('[ChatService] Dropping oversized envelope:', envelope.id, 'size:', payloadSize);
        return;
      }
    } catch {
      logger.warn('[ChatService] Dropping unserializable envelope:', envelope.id);
      return;
    }

    const dedupKey = `${envelope.category}:${envelope.id}`;
    if (this.processingMessages.has(dedupKey)) return;
    this.processingMessages.add(dedupKey);

    this.messageQueue = this.messageQueue
      .then(() => this.processEnvelope(envelope))
      .catch((error) => {
        logger.error('[ChatService] messageQueue error:', error);
      });
  }

  private async processEnvelope(envelope: MessageEnvelope): Promise<void> {
    const dedupKey = `${envelope.category}:${envelope.id}`;
    const roomId = envelope.id_room;

    try {
      switch (envelope.category) {
        case 'user':
          await this.handleUserMessage(envelope, roomId);
          break;
        case 'senderkey_message':
          await this.handleSenderKeyMessage(envelope, roomId);
          break;
        case 'control':
          await this.handleControlPacket(envelope, roomId);
          break;
        case 'system':
          await this.handleSystemMessage(envelope, roomId);
          break;
        default:
          logger.warn('[ChatService] Unknown category:', envelope.category);
      }
    } catch (error) {
      logger.error('[ChatService] handleIncomingMessage error:', error);
    } finally {
      setTimeout(() => this.processingMessages.delete(dedupKey), 60000);
    }
  }

  // ========================================
  // USER MESSAGES (pair-wise encrypted)
  // ========================================

  private async handleUserMessage(envelope: MessageEnvelope, roomId: number): Promise<void> {
    const userId = useAuthStore.getState().userId;
    logger.info(`[ChatService][User:${userId}] handleUserMessage:`, envelope.id, 'room:', roomId, 'from:', envelope.id_user_from);
    if (!userId) return;

    const existing = await messageRepository.findById(envelope.id);
    if (existing) return;

    const serverUserId = serverRegistry.getUserIdForRoom(roomId);
    const encryptedBody = this.extractCiphertextForSelf(envelope, [serverUserId, userId]);

    if (!encryptedBody) {
      logger.error('[ChatService] Missing encrypted body for user', userId, 'serverUserId:', serverUserId);
      return;
    }

    const decrypted = await this.decrypt(encryptedBody, roomId, envelope.id_user_from, envelope.device_id_from);
    if (decrypted === false) {
      logger.warn('[ChatService] Decrypt failed (may be from old session)', envelope.id);
      return;
    }

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(decrypted);
    } catch {
      parsedPayload = { text: decrypted };
    }

    const body = this.extractUserBody(envelope.type as UserMessageTypeValue, parsedPayload);

    const currentRoomId = useChatStore.getState().currentRoomId;
    const isViewingRoom = currentRoomId === roomId;

    // Multi-device self-fan-out: a message we authored on another linked
    // device of ours arrives here. We must render it as a SENT/own message
    // (right side of the bubble list, sent-status check marks), not as an
    // incoming DELIVERED message.
    const isSelfFanout =
      envelope.id_user_from === userId ||
      envelope.id_user_from === serverUserId;

    const message: NewMessage = {
      id: envelope.id,
      type: envelope.type,
      body,
      encryptedBody: '',
      idRoom: roomId,
      idUserFrom: envelope.id_user_from,
      idUserTo: envelope.id_user_to || 0,
      timestamp: envelope.timestamp,
      idStatus: isSelfFanout
        ? MessageStatus.SENT
        : (isViewingRoom ? MessageStatus.READ : MessageStatus.DELIVERED),
      read: isViewingRoom || isSelfFanout ? Math.floor(Date.now() / 1000) : null,
      version: envelope.version || '2.0',
      idParent: envelope.id_parent || null,
    };

    await messageRepository.create(message);

    const store = useChatStore.getState();
    store.addMessage(roomId, message as Message);
    store.updateRoomInList(roomId, { hasSession: true });
    store.setTyping(roomId, envelope.id_user_from, false);

    if (envelope.type === UserMessageType.IMAGE && parsedPayload?.base64) {
      this.persistImageToFilesystem(envelope.id, roomId, parsedPayload as ImageMessagePayload).catch((err) => {
        logger.warn('[ChatService] Received image persist failed:', err);
      });
    }

    if (envelope.type === UserMessageType.PERSISTENT_IMAGE && parsedPayload?.mediaId) {
      this.downloadAndDecryptPersistentImage(envelope.id, roomId, parsedPayload as PersistentImagePayload).catch((err) => {
        logger.warn('[ChatService] Persistent image download failed:', err);
      });
    }

    // Ephemeral images: do NOT auto-download. Body already contains metadata for lazy loading.

    this.updateRoomAfterMessage(roomId, body, envelope.type);

    // Suppress unread counter, haptic and banner for self-fan-out copies:
    // it's a message we authored ourselves on another linked device.
    if (!isViewingRoom && !isSelfFanout) {
      const currentRoom = store.allRooms.find(r => r.id === roomId);
      store.updateRoomInList(roomId, {
        unreadCount: (currentRoom?.unreadCount ?? 0) + 1,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      const roomName = currentRoom?.name || '';
      const senderProfile = store.profiles.get(roomId)?.get(envelope.id_user_from);
      const roomProfiles = store.profiles.get(roomId);
      const is1to1 = roomProfiles && roomProfiles.size === 2;
      useAppStore.getState().showNotificationBanner({
        roomId,
        roomName: (is1to1 && senderProfile?.username) ? senderProfile.username : roomName,
        senderName: is1to1 ? '' : (senderProfile?.username || ''),
        messagePreview: body,
        messageType: envelope.type,
        timestamp: Date.now(),
      });
    }

    // Skip delivery/read receipts for self-fan-out: we don't ack our own
    // message back to ourselves.
    if (!isSelfFanout) {
      // A message seen on arrival (room open) only needs a READ receipt —
      // READ implies DELIVERED, so sending both is redundant (frontend-0015 C).
      await this.sendControlPacket(
        roomId,
        isViewingRoom ? ControlPacketType.MESSAGE_READ : ControlPacketType.MESSAGE_DELIVERED,
        { id_message: envelope.id },
        envelope.id_user_from,
        { inline: true }
      );
    }
  }

  // ========================================
  // SENDER KEY MESSAGES (group encrypted)
  // ========================================

  private async handleSenderKeyMessage(
    envelope: MessageEnvelope,
    roomId: number,
    retryCount = 0
  ): Promise<void> {
    const userId = useAuthStore.getState().userId;
    logger.info(`[ChatService][User:${userId}] handleSenderKeyMessage:`, envelope.id, 'room:', roomId, 'from:', envelope.id_user_from, 'retry:', retryCount);

    try {
      const existing = await messageRepository.findById(envelope.id);
      if (existing) {
        logger.info(`[ChatService][User:${userId}] Sender key message already processed:`, envelope.id);
        return;
      }

      const senderUserId = envelope.id_user_from;
      const payload = envelope.payload as any;
      const ciphertext = payload?.ciphertext || payload?.message?.ciphertext || (envelope as any).ciphertext;

      logger.info(`[ChatService][User:${userId}] Sender key ciphertext found:`, !!ciphertext, 'length:', ciphertext?.length);

      if (!ciphertext) {
        logger.error('[ChatService] Sender key message missing ciphertext, payload:', JSON.stringify(payload).slice(0, 200));
        return;
      }

      let plaintext: string;
      try {
        plaintext = await senderKeyService.decryptWithSenderKey(roomId, senderUserId, ciphertext, envelope.device_id_from);
      } catch (decryptError: any) {
        const isError19 =
          decryptError?.message?.includes('SignalError error 19') ||
          decryptError?.message?.includes('error 19') ||
          decryptError?.code === 19;

        if (isError19 && retryCount === 0) {
          logger.info(`[ChatService][User:${userId}] No sender key state for user ${senderUserId}, fetching pending keys...`);
          await senderKeyService.fetchAndProcessPendingSenderKeys(roomId);
          return this.handleSenderKeyMessage(envelope, roomId, retryCount + 1);
        }
        throw decryptError;
      }

      const parsedPayload = JSON.parse(plaintext);
      const body = this.extractUserBody(envelope.type as UserMessageTypeValue, parsedPayload);

      const currentRoomId = useChatStore.getState().currentRoomId;
      const isViewingRoom = currentRoomId === roomId;

      const serverUserId = serverRegistry.getUserIdForRoom(roomId);
      const isSelfFanout =
        senderUserId === userId || senderUserId === serverUserId;

      const message: NewMessage = {
        id: envelope.id,
        type: envelope.type,
        body,
        encryptedBody: '',
        idRoom: roomId,
        idUserFrom: senderUserId,
        idUserTo: 0,
        timestamp: envelope.timestamp,
        idStatus: isSelfFanout
          ? MessageStatus.SENT
          : (isViewingRoom ? MessageStatus.READ : MessageStatus.DELIVERED),
        read: isViewingRoom || isSelfFanout ? Math.floor(Date.now() / 1000) : null,
        version: '2.0',
        idParent: envelope.id_parent || null,
      };

      await messageRepository.create(message);
      const store = useChatStore.getState();
      store.addMessage(roomId, message as Message);
      store.setTyping(roomId, senderUserId, false);

      if (envelope.type === UserMessageType.IMAGE && parsedPayload?.base64) {
        this.persistImageToFilesystem(envelope.id, roomId, parsedPayload as ImageMessagePayload).catch((err) => {
          logger.warn('[ChatService] Received SK image persist failed:', err);
        });
      }

      if (envelope.type === UserMessageType.PERSISTENT_IMAGE && parsedPayload?.mediaId) {
        this.downloadAndDecryptPersistentImage(envelope.id, roomId, parsedPayload as PersistentImagePayload).catch((err) => {
          logger.warn('[ChatService] SK persistent image download failed:', err);
        });
      }

      // Ephemeral images: do NOT auto-download.

      this.updateRoomAfterMessage(roomId, body, envelope.type);

      if (!isViewingRoom && !isSelfFanout) {
        const currentRoom = store.allRooms.find(r => r.id === roomId);
        store.updateRoomInList(roomId, {
          unreadCount: (currentRoom?.unreadCount ?? 0) + 1,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

        const roomName = currentRoom?.name || '';
        const senderProfile = store.profiles.get(roomId)?.get(senderUserId);
        const roomProfiles = store.profiles.get(roomId);
        const is1to1 = roomProfiles && roomProfiles.size === 2;
        useAppStore.getState().showNotificationBanner({
          roomId,
          roomName: (is1to1 && senderProfile?.username) ? senderProfile.username : roomName,
          senderName: is1to1 ? '' : (senderProfile?.username || ''),
          messagePreview: body,
          messageType: envelope.type,
          timestamp: Date.now(),
        });
      }

      // Skip delivery/read receipts for self-fan-out: we don't ack our own
      // message back to ourselves.
      if (!isSelfFanout) {
        // READ implies DELIVERED — send only one receipt (frontend-0015 C).
        await this.sendControlPacket(
          roomId,
          isViewingRoom ? ControlPacketType.MESSAGE_READ : ControlPacketType.MESSAGE_DELIVERED,
          { id_message: envelope.id },
          senderUserId,
          { inline: true }
        );
      }

      logger.info(`[ChatService][User:${userId}] Sender key message processed:`, envelope.id);
    } catch (error) {
      logger.error('[ChatService] Failed to decrypt sender key message:', error);
    }
  }

  // ========================================
  // CONTROL PACKETS
  // ========================================

  private async handleControlPacket(envelope: MessageEnvelope, roomId: number): Promise<void> {
    const userId = useAuthStore.getState().userId;
    logger.info(`[ChatService][User:${userId}] handleControlPacket:`, envelope.type, 'id:', envelope.id, 'room:', roomId, 'from:', envelope.id_user_from, 'encrypted:', envelope.encrypted);
    if (!userId) return;

    let packetPayload: any;

    if (!envelope.encrypted) {
      const payload = envelope.payload as any;
      packetPayload = typeof payload?.body === 'string'
        ? JSON.parse(payload.body)
        : payload?.body || payload;
    } else if ((envelope.payload as any)?.ciphertext && (envelope.payload as any)?.distributionId) {
      try {
        const decrypted = await senderKeyService.decryptWithSenderKey(
          roomId,
          envelope.id_user_from,
          (envelope.payload as any).ciphertext,
          envelope.device_id_from,
        );
        packetPayload = JSON.parse(decrypted);
      } catch (error: any) {
        const isError19 =
          error?.message?.includes('SignalError error 19') ||
          error?.message?.includes('error 19') ||
          error?.code === 19;

        if (isError19) {
          logger.info(`[ChatService][User:${userId}] Control packet: no sender key state from ${envelope.id_user_from}, fetching pending keys...`);
          try {
            await senderKeyService.fetchAndProcessPendingSenderKeys(roomId);
            const decrypted = await senderKeyService.decryptWithSenderKey(
              roomId,
              envelope.id_user_from,
              (envelope.payload as any).ciphertext,
              envelope.device_id_from,
            );
            packetPayload = JSON.parse(decrypted);
          } catch (retryError) {
            logger.error('[ChatService] Control packet sender key decrypt failed after retry:', retryError);
            return;
          }
        } else {
          logger.error('[ChatService] Control packet sender key decrypt failed:', error);
          return;
        }
      }
    } else {
      // Use server-specific user ID for the encrypted body lookup — each server
      // assigns its own user IDs, so ciphertext is keyed by the server-local ID.
      const serverUserId = serverRegistry.getUserIdForRoom(roomId);
      const encryptedBody = this.extractCiphertextForSelf(envelope, [serverUserId, userId]);

      if (!encryptedBody) {
        logger.error(`[ChatService][User:${userId}] Control packet missing encrypted body, type: ${envelope.type} serverUserId: ${serverUserId}`);
        return;
      }

      logger.info(`[ChatService][User:${userId}] Decrypting control packet type: ${envelope.type} from: ${envelope.id_user_from}/${envelope.device_id_from ?? 1}`);
      const decrypted = await this.decrypt(encryptedBody, roomId, envelope.id_user_from, envelope.device_id_from);
      if (decrypted === false) {
        logger.warn(`[ChatService][User:${userId}] Control packet decrypt failed, type: ${envelope.type} from: ${envelope.id_user_from}/${envelope.device_id_from ?? 1}`);
        return;
      }

      packetPayload = JSON.parse(decrypted);
    }

    await this.processControlPacket(
      envelope.type as ControlPacketTypeValue,
      packetPayload,
      roomId,
      envelope.id_user_from
    );
  }

  private async resolveMessageStatus(
    roomId: number,
    messageId: string,
  ): Promise<{ idStatus: number; idUserFrom: number; read: number | null } | undefined> {
    const inStore = useChatStore.getState().findMessageInRoom(roomId, messageId);
    if (inStore) {
      return {
        idStatus: inStore.idStatus,
        idUserFrom: inStore.idUserFrom,
        read: inStore.read ?? null,
      };
    }
    const row = await messageRepository.findById(messageId);
    return row
      ? { idStatus: row.idStatus, idUserFrom: row.idUserFrom, read: row.read ?? null }
      : undefined;
  }

  private async processControlPacket(
    type: ControlPacketTypeValue,
    payload: any,
    roomId: number,
    fromUserId: number
  ): Promise<void> {
    const store = useChatStore.getState();

    const selfUserId = useAuthStore.getState().userId;
    const serverUserId = serverRegistry.getUserIdForRoom(roomId);
    const isSelfFanout =
      fromUserId === selfUserId || (serverUserId != null && fromUserId === serverUserId);

    switch (type) {
      case ControlPacketType.MESSAGE_DELIVERED: {
        // Self-fanout DELIVERED has no semantics — our own other device
        // signaling delivery of our outgoing message back to us is a no-op
        // (the bubble is already at SENT/DELIVERED on this device). Skip
        // defensively to avoid spurious idStatus advance.
        if (isSelfFanout) {
          logger.info('[ChatService] Skipping self-fanout DELIVERED for:', payload.id_message);
          break;
        }

        const existingMsg = await this.resolveMessageStatus(roomId, payload.id_message);
        const currentStatus = existingMsg?.idStatus ?? 0;

        if (currentStatus < MessageStatus.DELIVERED) {
          logger.info('[ChatService] Processing DELIVERED for message:', payload.id_message, 'room:', roomId, 'currentStatus:', currentStatus);
          await messageRepository.updateStatus(payload.id_message, MessageStatus.DELIVERED);
          store.updateMessage(roomId, payload.id_message, { idStatus: MessageStatus.DELIVERED });
        } else {
          logger.info('[ChatService] Skipping DELIVERED for message:', payload.id_message, '- already at status:', currentStatus);
        }
        break;
      }

      case ControlPacketType.MESSAGE_READ: {
        // Coalesced receipts (frontend-0015 B): a READ packet may carry an
        // array of ids in `id_messages`, or a single `id_message`. Process
        // every id — an older peer still sends just `id_message`.
        // Contract: _shared/api/control-packet-read-coalesced.md
        const readIds: string[] =
          Array.isArray(payload.id_messages) && payload.id_messages.length > 0
            ? payload.id_messages
            : payload.id_message
              ? [payload.id_message]
              : [];

        // frontend-0020 — multi-device read sync. When another device of
        // the same user reads a conversation, a self-fanout MESSAGE_READ
        // lands here. The peer-read path (blind idStatus advance) is wrong
        // for incoming rows: it never stamps `read`, never recomputes the
        // unread counter, never refreshes the OS badge. Discriminate self
        // vs peer up front so the two paths stay independent.
        let appliedToIncoming = 0;

        for (const readId of readIds) {
          const existingMsg = await this.resolveMessageStatus(roomId, readId);
          if (!existingMsg) continue;
          if (existingMsg.idStatus === MessageStatus.FAILED || existingMsg.idStatus === MessageStatus.UNDELIVERED) continue;

          const isIncoming =
            existingMsg.idUserFrom !== selfUserId &&
            (serverUserId == null || existingMsg.idUserFrom !== serverUserId);

          if (isSelfFanout && isIncoming) {
            // Self-sync: another device of ours marked this incoming
            // message as read — stamp `read` on our row too. markAsRead
            // is idempotent (WHERE read IS NULL), so a re-applied packet
            // is a no-op on disk and on the store update.
            if (existingMsg.read == null) {
              await messageRepository.markAsRead(readId);
              store.updateMessage(roomId, readId, {
                read: Math.floor(Date.now() / 1000),
                idStatus: MessageStatus.READ,
              });
              appliedToIncoming++;
            }
            continue;
          }

          // Peer-read path (existing behaviour): outgoing message read by
          // the other side, advance idStatus. Also catches the defensive
          // case where the envelope claims self-fanout but targets an
          // outgoing row (malformed): falls through here, harmless.
          if (existingMsg.idStatus < MessageStatus.READ) {
            logger.info('[ChatService] Processing READ for message:', readId, 'room:', roomId, 'currentStatus:', existingMsg.idStatus);
            await messageRepository.updateStatus(readId, MessageStatus.READ);
            store.updateMessage(roomId, readId, { idStatus: MessageStatus.READ });
          } else {
            logger.info('[ChatService] Skipping READ for message:', readId, '- already at status:', existingMsg.idStatus);
          }
        }

        if (appliedToIncoming > 0) {
          logger.info('[ChatService] MESSAGE_READ self-fanout: applied to', appliedToIncoming, 'incoming in room', roomId);
          await this.recomputeRoomUnread(roomId);
          await this.refreshOsBadge();
        }
        break;
      }

      case ControlPacketType.PROFILE_UPDATED:
        if (payload.username) {
          await profileRepository.upsert({
            idUser: fromUserId,
            idRoom: roomId,
            username: payload.username,
          });
          store.updateProfile(roomId, fromUserId, { username: payload.username });
        }
        break;

      case ControlPacketType.SESSION_ESTABLISHED:
        // The decrypt of this packet already auto-established the session in
        // libsignal (PreKeySignalMessage → X3DH). We just need to update the
        // store and redistribute sender keys if needed.
        logger.info('[ChatService] SESSION_ESTABLISHED received from', fromUserId, 'in room', roomId);
        store.updateRoomInList(roomId, { hasSession: true });
        // Use username from SESSION_ESTABLISHED payload if available,
        // otherwise create placeholder only if no profile exists yet.
        {
          const peerUsername = payload?.username;
          if (peerUsername) {
            await profileRepository.upsert({
              idUser: fromUserId,
              idRoom: roomId,
              username: peerUsername,
            });
            store.updateProfile(roomId, fromUserId, { username: peerUsername });
          } else {
            const existingProfile = await profileRepository.findByUserAndRoom(fromUserId, roomId);
            if (!existingProfile) {
              const placeholder = `user-${fromUserId}`;
              await profileRepository.upsert({
                idUser: fromUserId,
                idRoom: roomId,
                username: placeholder,
              });
              store.updateProfile(roomId, fromUserId, { username: placeholder });
            }
          }
        }
        {
          const room = await roomRepository.findById(roomId);
          if (room?.useSenderKeys === 1) {
            try {
              await senderKeyService.redistributeToNewMembers(roomId, [fromUserId]);
            } catch (skError) {
              logger.warn('[ChatService] SESSION_ESTABLISHED: sender key redistribution failed:', skError);
            }
          }
        }
        break;

      case ControlPacketType.TYPING_STARTED: {
        const typingKey = `${roomId}:${fromUserId}`;
        const lastTyping = this.typingReceiveThrottle.get(typingKey) || 0;
        const now = Date.now();
        if (now - lastTyping < 1000) break;
        this.typingReceiveThrottle.set(typingKey, now);
        store.setTyping(roomId, fromUserId, true);
        break;
      }

      case ControlPacketType.TYPING_STOPPED:
        store.setTyping(roomId, fromUserId, false);
        break;

      default:
        logger.info('[ChatService] Unknown control packet type:', type);
    }
  }


  // ========================================
  // SYSTEM MESSAGES
  // ========================================

  private async handleSystemMessage(envelope: MessageEnvelope, roomId: number): Promise<void> {
    const payload = envelope.payload as any;

    switch (envelope.type) {
      case 'user_joined':
        if (payload.user_id) {
          const joinedUsername = payload.username || `user-${payload.user_id}`;
          await profileRepository.upsert({
            idUser: payload.user_id,
            idRoom: roomId,
            username: joinedUsername,
          });
          useChatStore.getState().updateProfile(roomId, payload.user_id, { username: joinedUsername });

          // Establish session with the new member (skip self).
          // This handles the real-time (online) case. If offline,
          // syncRoomMembersAndSessions() on reconnect catches it.
          // If B's first message arrives before this, decryptMessage()
          // auto-establishes the session via PreKeySignalMessage.
          const joinedUserId = useAuthStore.getState().userId;
          const joinedServerUserId = serverRegistry.getUserIdForRoom(roomId);
          if (payload.user_id !== joinedUserId && payload.user_id !== joinedServerUserId) {
            const existingSession = await sessionRepository.findByUserAndRoom(
              String(payload.user_id),
              roomId
            );

            if (!existingSession) {
              logger.info('[ChatService] user_joined: establishing session with', payload.user_id, 'in room', roomId);
              try {
                const success = await sessionService.setSession(
                  roomId,
                  payload.user_id,
                  payload.username || `user-${payload.user_id}`,
                  1
                );

                if (success) {
                  useChatStore.getState().updateRoomInList(roomId, { hasSession: true });

                  const room = await roomRepository.findById(roomId);
                  if (room?.useSenderKeys === 1) {
                    try {
                      await senderKeyService.redistributeToNewMembers(roomId, [payload.user_id]);
                    } catch (skError) {
                      logger.warn('[ChatService] user_joined: sender key redistribution failed:', skError);
                    }
                  }
                }
              } catch (error) {
                logger.warn('[ChatService] user_joined: session establishment failed for', payload.user_id, error);
              }
            }
          }
        }
        break;

      case 'user_left':
        logger.info('[ChatService] User left room:', payload.user_id);
        break;

      case 'room_deleted':
        logger.info('[ChatService] room_deleted received for room', roomId);
        await this.performLocalRoomCleanup(roomId);
        break;

      case 'room_renamed':
        if (payload.newName) {
          await roomRepository.update(roomId, { name: payload.newName });
          useChatStore.getState().updateRoomInList(roomId, { name: payload.newName });
        }
        break;

      case 'message_deleted': {
        const deletedMessageId = payload.message_id;
        if (!deletedMessageId) {
          logger.warn('[ChatService] message_deleted: no message_id in payload');
          break;
        }

        const existingMsg = await messageRepository.findById(deletedMessageId);
        logger.info('[ChatService] message_deleted:', deletedMessageId, 'room:', roomId, 'found:', !!existingMsg);

        if (existingMsg) {
          if (existingMsg.type === UserMessageType.IMAGE || existingMsg.type === UserMessageType.PERSISTENT_IMAGE || existingMsg.type === UserMessageType.EPHEMERAL_IMAGE) {
            deleteImagesByMessageIds([deletedMessageId]);
          }
          await messageRepository.delete(deletedMessageId);
          useChatStore.getState().removeMessage(roomId, deletedMessageId);
          await this.refreshRoomLastMessage(roomId);
        } else {
          // Message already deleted locally (sender echo) — just ensure store is clean
          useChatStore.getState().removeMessage(roomId, deletedMessageId);
        }
        break;
      }

      default:
        logger.warn('[ChatService] Unknown system message type:', envelope.type);
    }
  }

  // ========================================
  // ENCRYPTION / DECRYPTION
  // ========================================

  /**
   * Encrypt a payload for delivery to all members of a room.
   *
   * Sender-key rooms: one ciphertext + distributionId (group cipher).
   *
   * Pair-wise rooms: peer fan-out. For each peer `userId`, iterate the
   * device list cached in `sessionService.getRemoteDeviceIds(userId)`
   * (populated by /keys fetch). If the cache is empty for a peer, fall
   * back to `[PRIMARY_DEVICE_ID]` so a single-device peer (or one we
   * have not yet fetched keys for) still receives a ciphertext.
   *
   * Returns `recipients: Array<{ userId, deviceId, ciphertext }>` for
   * the new wire format. The server smista each element to the matching
   * (userId, deviceId) socket; offline devices get queued individually.
   */
  private async encrypt(
    roomId: number,
    message: string
  ): Promise<{ senderKey?: boolean; ciphertext?: string; distributionId?: string; recipients?: Array<{ userId: number; deviceId: number; ciphertext: string }> }> {
    const room = await roomRepository.findById(roomId);
    if (room?.useSenderKeys === 1) {
      try {
        const { ciphertext, distributionId } = await senderKeyService.encryptWithSenderKey(roomId, message);
        return { senderKey: true, ciphertext, distributionId };
      } catch (error) {
        logger.warn('[ChatService] Sender key encryption failed, falling back to pair-wise:', error);
      }
    }

    const sessions = await sessionRepository.findByRoom(roomId);
    const ownUserId = String(serverRegistry.getUserIdForRoom(roomId) || useAuthStore.getState().userId || '');

    logger.info('[ChatService] encrypt: room:', roomId, 'sessions:', sessions.length, 'ownUserId:', ownUserId,
      sessions.length > 0 ? 'sessionUsers: ' + sessions.map(s => s.idUser).join(',') : '(no sessions in DB for this room)');

    if (!sessions || sessions.length === 0) {
      throw new Error('No sessions found for room');
    }

    const recipients: Array<{ userId: number; deviceId: number; ciphertext: string }> = [];

    // Dedup by userId: multi-device peers have one session row per linked
    // device, so iterating raw `sessions` rows would fan-out N×deviceCount
    // times (re-encrypting the same message multiple times per recipient,
    // advancing the ratchet on the receiver and producing decrypt errors
    // for the duplicates). The inner deviceIds loop already addresses every
    // (userId, deviceId) — we only need one outer pass per unique userId.
    const uniquePeerUserIds = new Set<string>();
    for (const session of sessions) {
      const uid = String(session.idUser);
      if (uid !== ownUserId) uniquePeerUserIds.add(uid);
    }

    for (const remoteUserId of uniquePeerUserIds) {
      await sessionService.ensureSession(roomId, Number(remoteUserId));

      // Multi-device fan-out: encrypt one ciphertext per (userId, deviceId).
      // Fall back to [PRIMARY_DEVICE_ID] when we have no device list yet
      // (single-device peer or pre-multi-device cache state).
      const cached = sessionService.getRemoteDeviceIds(remoteUserId);
      const deviceIds = cached.length > 0 ? cached : [PRIMARY_DEVICE_ID];

      const peerStartCount = recipients.length;

      for (const deviceId of deviceIds) {
        // Lazy per-device session establishment: the deviceMap may include a
        // device the peer linked AFTER our original session was set up, so
        // libsignal has no session for (peer, deviceId) yet. PRIMARY_DEVICE_ID
        // is the original session — skip the ensure call for it (we know it
        // exists via the `ensureSession` above) to avoid an unnecessary /keys
        // fetch on every send.
        if (deviceId !== PRIMARY_DEVICE_ID) {
          const sessionReady = await sessionService.ensureSessionForRemotePeerDevice(
            roomId,
            remoteUserId,
            deviceId,
          );
          if (!sessionReady) {
            logger.warn(`[ChatService] encrypt: peer-fanout session not ready for ${remoteUserId}/${deviceId}, skipping`);
            continue;
          }
        }

        try {
          const { encryptedMessage } = await SignalProtocol.encryptMessage(
            encodeURIComponent(message),
            remoteUserId,
            deviceId,
          );
          logger.info('[ChatService] encrypt: encrypted for', remoteUserId + '/' + deviceId, 'OK, length:', encryptedMessage?.length);
          // Backend DTO (FanoutRecipientDto) requires `userId: number` and the
          // ValidationPipe does not implicit-convert — sending a string here
          // silently fails the validator, the gateway never invokes the
          // handler, and the client times out after 30s waiting for the ack.
          recipients.push({ userId: Number(remoteUserId), deviceId, ciphertext: encryptedMessage });
        } catch (encError) {
          logger.error('[ChatService] encrypt: encryptMessage FAILED for', remoteUserId + '/' + deviceId, encError);
          // For non-primary devices, swallow the error so a single bad
          // (peer, deviceId) doesn't drop the message for all recipients
          // (including the peer's primary). The primary failing is still
          // a real problem and should propagate.
          if (deviceId === PRIMARY_DEVICE_ID) {
            throw encError;
          }
        }
      }

      // A4: failover — if the cached device list yielded ZERO recipients
      // for this peer (every per-device session failed AND the cache did
      // not include PRIMARY_DEVICE_ID), try the primary explicitly. This
      // covers the edge case where the cache is stale on revoked secondaries
      // and the peer is actually reachable only on the primary, which would
      // otherwise be silently skipped.
      if (recipients.length === peerStartCount && !deviceIds.includes(PRIMARY_DEVICE_ID)) {
        logger.warn(
          `[ChatService] encrypt: 0 recipients for ${remoteUserId} from cached devices [${deviceIds.join(',')}] — attempting PRIMARY failover`,
        );
        const primaryReady = await sessionService.ensureSessionForRemotePeerDevice(
          roomId,
          remoteUserId,
          PRIMARY_DEVICE_ID,
        );
        if (primaryReady) {
          try {
            const { encryptedMessage } = await SignalProtocol.encryptMessage(
              encodeURIComponent(message),
              remoteUserId,
              PRIMARY_DEVICE_ID,
            );
            recipients.push({
              userId: Number(remoteUserId),
              deviceId: PRIMARY_DEVICE_ID,
              ciphertext: encryptedMessage,
            });
            logger.info(`[ChatService] encrypt: PRIMARY failover succeeded for ${remoteUserId}`);
          } catch (failoverErr) {
            logger.error(
              `[ChatService] encrypt: PRIMARY failover encrypt failed for ${remoteUserId}:`,
              failoverErr,
            );
          }
        }
      }

      if (recipients.length === peerStartCount) {
        // Even the failover gave up. Don't fail the entire send — other peers
        // may still get the message — but make the silent drop loud in logs
        // so we can correlate with "missing message" reports from the field.
        logger.warn(
          `[ChatService] encrypt: peer ${remoteUserId} unreachable (no device produced a ciphertext); message will not be delivered to this peer`,
        );
      }
    }

    // Self-fan-out (multi-device): if WE have linked devices besides this one,
    // encrypt a copy of the outgoing message for each so they stay in sync
    // with what we sent. Failure to encrypt for a self-linked target is
    // logged and skipped — peer recipients are already in `recipients` and
    // we do not want a missing self-copy to fail the send.
    //
    // We skip our OWN deviceId using the cached value from `auth.store`
    // (populated at bootstrap via `SignalProtocol.getPublicIdentity()`).
    // If the cache is still null (rare race), fall back to skipping
    // `PRIMARY_DEVICE_ID`, which is correct for the primary device.
    if (ownUserId) {
      const ownDeviceId = useAuthStore.getState().deviceId ?? PRIMARY_DEVICE_ID;
      const selfDeviceIds = sessionService.getRemoteDeviceIds(ownUserId);
      for (const deviceId of selfDeviceIds) {
        if (deviceId === ownDeviceId) continue;
        try {
          const ok = await sessionService.ensureSessionForOwnLinkedDevice(
            roomId,
            Number(ownUserId),
            deviceId,
          );
          if (!ok) {
            logger.warn(`[ChatService] encrypt: self-fanout session not ready for ${ownUserId}/${deviceId}, skipping`);
            continue;
          }
          const { encryptedMessage } = await SignalProtocol.encryptMessage(
            encodeURIComponent(message),
            ownUserId,
            deviceId,
          );
          recipients.push({ userId: Number(ownUserId), deviceId, ciphertext: encryptedMessage });
          logger.info('[ChatService] encrypt: self-fanout for', ownUserId + '/' + deviceId, 'OK');
        } catch (err) {
          logger.warn(`[ChatService] encrypt: self-fanout FAILED for ${ownUserId}/${deviceId}:`, err);
        }
      }
    }

    if (recipients.length === 0) {
      throw new Error('No remote sessions available for room');
    }

    return { recipients };
  }

  /**
   * Emit a `sendMessage` over the socket, picking the wire shape from the
   * already-encrypted `serverBody`:
   *
   *  - `serverBody.payload.recipients[]` present → multi-device fan-out
   *    shape: `recipients[]` + `metadata` travel **top-level**. The backend
   *    gateway only routes to `fanOutToRecipients` when `recipients` is
   *    top-level; nesting it inside `message` falls back to the legacy
   *    single-broadcast path, which filters by `userId` and so drops the
   *    copy meant for the sender's own other devices (multi-device bug).
   *  - otherwise (sender-key single ciphertext) → legacy `message` envelope.
   *
   * Contract: `_shared/specs/multidevice-send-wire-shape.md`.
   */
  private emitSendMessage(
    socket: SocketService,
    roomId: number,
    serverBody: any,
    category: string,
    type: string,
  ): Promise<SendMessageAck> {
    const recipients = serverBody?.payload?.recipients;
    const volatile = serverBody?.volatile === true;

    if (Array.isArray(recipients) && recipients.length > 0) {
      const metadata: SendMessageMetadata = {};
      if (serverBody?.id_parent) metadata.id_parent = serverBody.id_parent;
      if (serverBody?.version) metadata.version = serverBody.version;
      const envelopeId = typeof serverBody?.id === 'string' ? serverBody.id : undefined;
      return socket.sendMessage({
        roomId,
        ...(envelopeId ? { id: envelopeId } : {}),
        recipients,
        ...(metadata.id_parent || metadata.version ? { metadata } : {}),
        category,
        type,
        volatile,
      });
    }

    return socket.sendMessage({
      roomId,
      message: serverBody,
      category,
      type,
      volatile,
    });
  }

  private async decrypt(
    body: string,
    roomId: number,
    fromUserId: number,
    fromDeviceId?: number | null,
    retryCount = 0
  ): Promise<string | false> {
    const globalUserId = String(useAuthStore.getState().userId || '');
    const serverUserId = String(serverRegistry.getUserIdForRoom(roomId) || globalUserId);
    const remoteUserId = String(fromUserId);
    const ownDeviceId = useAuthStore.getState().deviceId ?? PRIMARY_DEVICE_ID;

    try {
      // Multi-device: a "self" message (`remoteUserId === self`) is only a
      // true echo of our own send if the sender device is EXPLICITLY ours.
      // Without `fromDeviceId` on the wire we cannot distinguish an echo
      // from a self-fanout copy authored by another linked device — defaulting
      // to PRIMARY_DEVICE_ID would silently drop legitimate self-fanouts on
      // the primary. Returning false here means the caller treats the
      // envelope as "skipped"; for self-fanout that lands on this path we
      // want to attempt the decrypt and let the normal flow render it.
      const isOwnUser = remoteUserId === globalUserId || remoteUserId === serverUserId;
      if (isOwnUser && typeof fromDeviceId === 'number' && fromDeviceId === ownDeviceId) return false;

      // Multi-device: libsignal sessions are keyed by `(userId, deviceId)`.
      // Without the sender's deviceId, the native fallback defaults to 1 and
      // we look up the wrong session — a message from a linked peer device
      // would be decoded against the primary's ratchet and fail with
      // "protobuf encoding was invalid".
      const effectiveDeviceId = fromDeviceId ?? null;

      logger.info(`[ChatService][User:${globalUserId}] decrypt: from user ${remoteUserId}/${effectiveDeviceId ?? 1}, room ${roomId}, bodyLen: ${body?.length}`);

      const decryptResult = await SignalProtocol.decryptMessage(body, remoteUserId, effectiveDeviceId);

      logger.info(`[ChatService][User:${globalUserId}] decrypt: SUCCESS from user ${remoteUserId}`);

      // Persist the (userId, roomId, deviceId) triple so loadSessions can
      // resume this session at next boot. Without the deviceId hint, a
      // message from a linked device 4 would only ever record a row for
      // deviceId=1, and the next restart would lose the libsignal session
      // that the auto-establish path silently set up during this decrypt.
      await sessionService.ensureSessionInDatabase(roomId, remoteUserId, effectiveDeviceId ?? undefined);
      await sessionService.updateSessionTimestamp(roomId, remoteUserId);

      return decodeURIComponent(decryptResult.message);
    } catch (error: any) {
      logger.warn(`[ChatService][User:${globalUserId}] Decrypt error from user ${remoteUserId}/${fromDeviceId ?? 1}, room ${roomId}:`, error?.message || error);

      const isError12 =
        error?.message?.includes('SignalError 12') ||
        error?.message?.includes('UntrustedIdentity') ||
        error?.code === 12;

      if (isError12) {
        logger.error('[ChatService] SECURITY: Identity key mismatch!');
        sessionService.handleIdentityKeyChanged(roomId, fromUserId);
        return false;
      }

      const isError11 =
        error?.message?.includes('SignalError error 11') ||
        error?.message?.includes('invalidKey') ||
        error?.message?.includes('No pre-key with id') ||
        error?.code === 11;

      if (isError11 && retryCount === 0) {
        logger.warn('[ChatService] Pre-key not found — recovering session with', fromUserId);
        try {
          await sessionService.recoverSession(roomId, String(fromUserId), `user-${fromUserId}`);
          sessionService.refreshPreKeysIfNeeded(getServerIdFromRoomId(roomId) || undefined).catch(() => {});
        } catch (recoverError) {
          logger.error('[ChatService] Session recovery failed:', recoverError);
        }
        return false;
      }

      const isError6 =
        error?.message?.includes('SignalError 6') ||
        error?.message?.includes('InvalidMessage') ||
        error?.code === 6;

      if (isError6) {
        logger.warn(`[ChatService][User:${globalUserId}] Error 6 (InvalidMessage) from user ${remoteUserId} - NOT recovering to preserve in-flight messages`);
      }

      return false;
    }
  }

  /**
   * Locate the ciphertext addressed to this device inside a fanned-out
   * envelope. Accepts three wire formats:
   *
   *   1. `payload.recipients: [{ userId, deviceId, ciphertext }]` — new
   *      multi-device format. The server already fans out one envelope per
   *      target (userId, deviceId), so the array we receive has 1 entry
   *      addressed to us; we just need to read its ciphertext.
   *   2. `payload.body: { [userId]: ciphertext }` — legacy single-device map.
   *   3. `(envelope as any).body: { [userId]: ciphertext }` — even older
   *      legacy where `body` lived at envelope root rather than under `payload`.
   *
   * `selfUserIds` is the list of identifiers that count as "me" on the room's
   * server (server-local user id + global user id), since they may differ.
   */
  private extractCiphertextForSelf(
    envelope: MessageEnvelope,
    selfUserIds: Array<string | number | null | undefined>,
  ): string | null {
    const payload = envelope.payload as any;
    const ids = selfUserIds.filter((x) => x !== null && x !== undefined).map((x) => String(x));

    // Multi-device fan-out wire shape: the backend's `fanOutToRecipients`
    // already picks the per-device ciphertext and sets `envelope.message`
    // to the base64 string. `normalizeFromSocketWrapper` propagates that
    // through as `envelope.payload`, so a plain string here means "this
    // ciphertext is already for me".
    if (typeof payload === 'string' && payload.length > 0) {
      return payload;
    }

    // Control-packet fan-out wire shape (frontend-0019): backend
    // `fanOutPacketToRecipients` delivers the per-device envelope as-is, so
    // `payload.ciphertext` is the single string for this device. We
    // exclude the sender-key case (distinguished by `distributionId`) — that
    // shape carries its own dedicated decrypt path upstream.
    if (typeof payload?.ciphertext === 'string' && payload.ciphertext.length > 0 && !payload.distributionId) {
      return payload.ciphertext;
    }

    if (Array.isArray(payload?.recipients)) {
      const entries = payload.recipients as Array<{ userId?: string | number; ciphertext?: string }>;
      const match =
        entries.find((e) => e?.ciphertext && ids.includes(String(e.userId))) ||
        (entries.length === 1 && entries[0]?.ciphertext ? entries[0] : undefined);
      if (match?.ciphertext) return match.ciphertext;
    }

    for (const id of ids) {
      const fromPayload = payload?.body?.[id];
      if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
      const fromRoot = (envelope as any).body?.[id];
      if (typeof fromRoot === 'string' && fromRoot) return fromRoot;
    }

    return null;
  }

  // ========================================
  // SENDING MESSAGES
  // ========================================

  async sendMessage(
    roomId: number,
    text: string,
    parentId?: string,
    replaceMessageId?: string
  ): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    const envelope = MessageEnvelopeFactory.createTextMessage(roomId, userId, text, {
      id_parent: parentId,
      encrypted: true,
    });

    await this.sendEnvelope(envelope, text, replaceMessageId ? { replaceMessageId } : undefined);
  }

  async sendImageMessage(
    roomId: number,
    imagePayload: ImageMessagePayload,
    parentId?: string,
    replaceMessageId?: string
  ): Promise<SendResult> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    // 1. Determine IDs upfront for optimistic message
    const room = await roomRepository.findById(roomId);
    const isSenderKeyRoom = room?.useSenderKeys === 1;
    const envelopeId = generateUUID();
    const localId = isSenderKeyRoom ? generateLocalId() : envelopeId;

    // 2. Show message immediately with base64 body (no thumbnail yet)
    const store = useChatStore.getState();
    const message: Message = {
      id: localId,
      type: UserMessageType.IMAGE,
      body: JSON.stringify(imagePayload),
      encryptedBody: '',
      idRoom: roomId,
      idUserFrom: userId,
      idUserTo: 0,
      timestamp: Date.now(),
      idStatus: MessageStatus.SENDING,
      version: '2.0',
      idParent: parentId || null,
      read: null,
      expiryDatetime: null,
      lastModified: null,
    };
    if (replaceMessageId) {
      store.swapMessage(roomId, replaceMessageId, message);
      await messageRepository.delete(replaceMessageId);
    } else {
      store.addMessage(roomId, message);
    }
    await messageRepository.create(message);

    // 3. Generate thumbnail (UI already showing the message)
    if (!imagePayload.thumbnail) {
      try {
        const thumbnail = await generateThumbnailFromBase64(
          imagePayload.base64,
          imagePayload.mimeType
        );
        if (thumbnail) {
          imagePayload.thumbnail = thumbnail;
        }
      } catch (error) {
        logger.warn('[ChatService] Thumbnail generation failed, sending without:', error);
      }
    }

    // 4. Create envelope with full payload (including thumbnail)
    const envelope = MessageEnvelopeFactory.createImageMessage(roomId, userId, imagePayload, {
      id_parent: parentId,
      encrypted: true,
    });
    envelope.id = envelopeId;

    // 5. Encrypt + send (skip optimistic message creation — already done above)
    const result = await this.sendEnvelope(envelope, JSON.stringify(imagePayload), {
      skipOptimistic: true,
      localId,
    });

    // 6. Persist to filesystem (fire-and-forget)
    this.persistImageToFilesystem(result.messageId, roomId, imagePayload).catch((err) => {
      logger.warn('[ChatService] Post-send image persist failed:', err);
    });

    return result;
  }

  async sendPersistentImageMessage(
    roomId: number,
    imagePayload: ImageMessagePayload,
    parentId?: string,
    replaceMessageId?: string
  ): Promise<SendResult> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    // 1. Create optimistic message immediately with base64 body
    const envelopeId = generateUUID();
    const optimisticBody = JSON.stringify({
      base64: imagePayload.base64,
      thumbnail: '',
      width: imagePayload.width,
      height: imagePayload.height,
      mimeType: imagePayload.mimeType,
    });

    const store = useChatStore.getState();
    const message: Message = {
      id: envelopeId,
      type: UserMessageType.PERSISTENT_IMAGE,
      body: optimisticBody,
      encryptedBody: '',
      idRoom: roomId,
      idUserFrom: userId,
      idUserTo: 0,
      timestamp: Date.now(),
      idStatus: MessageStatus.SENDING,
      version: '2.0',
      idParent: parentId || null,
      read: null,
      expiryDatetime: null,
      lastModified: null,
    };
    if (replaceMessageId) {
      store.swapMessage(roomId, replaceMessageId, message);
      await messageRepository.delete(replaceMessageId);
    } else {
      store.addMessage(roomId, message);
    }
    await messageRepository.create(message);

    // 2. Generate thumbnails: large (local UI only, store/DB) + micro (WS payload).
    // The micro-thumbnail keeps the reference message under the backend's 64KB
    // WS limit (amplified by per-device fan-out); the large one never leaves the
    // device — the bubble reads it from store/DB.
    if (!imagePayload.thumbnail) {
      try {
        const thumbnail = await generateThumbnailFromBase64(
          imagePayload.base64,
          imagePayload.mimeType
        );
        if (thumbnail) imagePayload.thumbnail = thumbnail;
      } catch (error) {
        logger.warn('[ChatService] Persistent: thumbnail generation failed:', error);
      }
    }

    let microThumbnail = '';
    try {
      microThumbnail = await generateMicroThumbnailFromBase64(
        imagePayload.base64,
        imagePayload.mimeType
      );
    } catch (error) {
      logger.warn('[ChatService] Persistent: micro-thumbnail generation failed:', error);
    }

    // 3. Save original image to filesystem
    const filePath = await saveImageToFile(imagePayload.base64, generateUUID(), imagePayload.mimeType);

    // 4. Update body with filePath + thumbnail (replaces base64 in store/DB)
    const updatedBody = JSON.stringify({
      filePath,
      thumbnail: imagePayload.thumbnail || '',
      width: imagePayload.width,
      height: imagePayload.height,
      mimeType: imagePayload.mimeType,
    });
    await messageRepository.updateBody(envelopeId, updatedBody);
    store.updateMessage(roomId, envelopeId, { body: updatedBody });

    // 5-9 in messageQueue (serialized)
    let finalStatus: MessageStatusType = MessageStatus.SENDING;
    const sendOp = async () => {
      try {
        // 4. AES encrypt image (native platform crypto, works with base64 directly)
        const { encryptedBase64, keyBase64, ivBase64 } = await mediaCryptoService.encrypt(imagePayload.base64);

        // 5. Upload to server
        const api = serverRegistry.getApiForRoom(roomId);
        const backendRoomId = toBackendRoomId(roomId);
        const uploadResult = await api.uploadMedia(
          backendRoomId,
          encryptedBase64,
          imagePayload.mimeType || 'image/jpeg'
        );

        // 6. Create envelope
        const persistentPayload: PersistentImagePayload = {
          mediaId: uploadResult.mediaId,
          mediaKey: keyBase64,
          iv: ivBase64,
          // WS payload carries only the micro-thumbnail (~<3KB) to stay under the
          // backend's 64KB limit; the large thumbnail lives in store/DB (step 4).
          thumbnail: microThumbnail,
          mimeType: imagePayload.mimeType || 'image/jpeg',
          width: imagePayload.width || 0,
          height: imagePayload.height || 0,
          size: imagePayload.size || 0,
        };

        const envelope = MessageEnvelopeFactory.createPersistentImageMessage(
          roomId, userId, persistentPayload, { id_parent: parentId, encrypted: true }
        );
        envelope.id = envelopeId;

        // 7. Signal encrypt + send
        const payloadString = JSON.stringify(envelope.payload);
        const encryptedData = await this.encrypt(roomId, payloadString);
        const serverUserId = serverRegistry.getUserIdForRoom(roomId) || userId;
        const bkRoomId = toBackendRoomId(roomId);

        let serverBody: any;
        let category = envelope.category;

        if (encryptedData.senderKey) {
          category = 'senderkey_message' as const;
          serverBody = {
            id: envelope.id,
            timestamp: envelope.timestamp,
            category: 'senderkey_message',
            type: envelope.type,
            payload: {
              ciphertext: encryptedData.ciphertext,
              distributionId: encryptedData.distributionId,
            },
            id_room: bkRoomId,
            id_user_from: serverUserId,
            version: '2.0',
            id_parent: envelope.id_parent,
          };
        } else {
          serverBody = {
            ...envelope,
            id_room: bkRoomId,
            id_user_from: serverUserId,
            payload: { recipients: encryptedData.recipients },
          };
        }

        const socket = serverRegistry.getSocketForRoom(roomId);
        const result = await this.emitSendMessage(socket, bkRoomId, serverBody, category, envelope.type);

        if (result?.success) {
          await messageRepository.updateStatus(envelopeId, MessageStatus.SENT);
          store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.SENT });
          this.updateRoomAfterMessage(roomId, JSON.stringify(persistentPayload), envelope.type);
          finalStatus = MessageStatus.SENT;
        } else {
          throw new Error(result?.error || 'Send failed');
        }
      } catch (error: any) {
        logger.error('[ChatService] sendPersistentImage error:', error?.message || error);
        await messageRepository.updateStatus(envelopeId, MessageStatus.FAILED);
        store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.FAILED });
        finalStatus = MessageStatus.FAILED;
      }
    };

    this.messageQueue = this.messageQueue.then(sendOp).catch((e) => {
      logger.error('[ChatService] sendPersistentImage queue error:', e);
    });
    await this.messageQueue;

    return { messageId: envelopeId, status: finalStatus };
  }

  /**
   * Send an ephemeral (self-destructing) image message.
   * The image is AES-encrypted and uploaded to the server with ephemeral flag.
   * The receiver must tap to view — the image is downloaded once, decrypted in
   * memory, shown inside a SecureView with a countdown timer, then destroyed.
   */
  async sendEphemeralImageMessage(
    roomId: number,
    imagePayload: ImageMessagePayload,
    viewDuration: number,
    ttlHours: number,
    parentId?: string
  ): Promise<SendResult> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    const envelopeId = generateUUID();

    // Generate a blurred thumbnail for the "tap to view" placeholder
    let blurThumbnail = '';
    try {
      blurThumbnail = await generateColorPreviewFromBase64(
        imagePayload.base64,
        imagePayload.mimeType,
      );
    } catch (error) {
      logger.warn('[ChatService] Ephemeral: blur thumbnail generation failed:', error);
    }

    // Optimistic body for sender — only thumbnail blur, no image data
    const senderBody = JSON.stringify({
      thumbnail: blurThumbnail,
      viewDuration,
      width: imagePayload.width,
      height: imagePayload.height,
      mimeType: imagePayload.mimeType,
    });

    const store = useChatStore.getState();
    const message: Message = {
      id: envelopeId,
      type: UserMessageType.EPHEMERAL_IMAGE,
      body: senderBody,
      encryptedBody: '',
      idRoom: roomId,
      idUserFrom: userId,
      idUserTo: 0,
      timestamp: Date.now(),
      idStatus: MessageStatus.SENDING,
      version: '2.0',
      idParent: parentId || null,
      read: null,
      expiryDatetime: null,
      lastModified: null,
    };
    store.addMessage(roomId, message);
    await messageRepository.create(message);

    let finalStatus: MessageStatusType = MessageStatus.SENDING;
    const sendOp = async () => {
      try {
        // AES encrypt image
        const { encryptedBase64, keyBase64, ivBase64 } = await mediaCryptoService.encrypt(imagePayload.base64);

        // Upload to server with ephemeral flag
        const api = serverRegistry.getApiForRoom(roomId);
        const backendRoomId = toBackendRoomId(roomId);
        const uploadResult = await api.uploadEphemeralMedia(
          backendRoomId,
          encryptedBase64,
          imagePayload.mimeType || 'image/jpeg',
          ttlHours
        );

        // Build ephemeral payload for Signal-encrypt
        const ephemeralPayload: EphemeralImagePayload = {
          mediaId: uploadResult.mediaId,
          mediaKey: keyBase64,
          iv: ivBase64,
          thumbnail: blurThumbnail,
          mimeType: imagePayload.mimeType || 'image/jpeg',
          width: imagePayload.width || 0,
          height: imagePayload.height || 0,
          size: imagePayload.size || 0,
          viewDuration,
        };

        const envelope = MessageEnvelopeFactory.createEphemeralImageMessage(
          roomId, userId, ephemeralPayload, { id_parent: parentId, encrypted: true }
        );
        envelope.id = envelopeId;

        // Signal encrypt + send
        const payloadString = JSON.stringify(envelope.payload);
        const encryptedData = await this.encrypt(roomId, payloadString);
        const serverUserId = serverRegistry.getUserIdForRoom(roomId) || userId;
        const bkRoomId = toBackendRoomId(roomId);

        let serverBody: any;
        let category = envelope.category;

        if (encryptedData.senderKey) {
          category = 'senderkey_message' as const;
          serverBody = {
            id: envelope.id,
            timestamp: envelope.timestamp,
            category: 'senderkey_message',
            type: envelope.type,
            payload: {
              ciphertext: encryptedData.ciphertext,
              distributionId: encryptedData.distributionId,
            },
            id_room: bkRoomId,
            id_user_from: serverUserId,
            version: '2.0',
            id_parent: envelope.id_parent,
          };
        } else {
          serverBody = {
            ...envelope,
            id_room: bkRoomId,
            id_user_from: serverUserId,
            payload: { recipients: encryptedData.recipients },
          };
        }

        const socket = serverRegistry.getSocketForRoom(roomId);
        const result = await this.emitSendMessage(socket, bkRoomId, serverBody, category, envelope.type);

        if (result?.success) {
          await messageRepository.updateStatus(envelopeId, MessageStatus.SENT);
          store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.SENT });
          this.updateRoomAfterMessage(roomId, JSON.stringify(ephemeralPayload), envelope.type);
          finalStatus = MessageStatus.SENT;
        } else {
          throw new Error(result?.error || 'Send failed');
        }
      } catch (error: any) {
        logger.error('[ChatService] sendEphemeralImage error:', error?.message || error);
        await messageRepository.updateStatus(envelopeId, MessageStatus.FAILED);
        store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.FAILED });
        finalStatus = MessageStatus.FAILED;
      }
    };

    this.messageQueue = this.messageQueue.then(sendOp).catch((e) => {
      logger.error('[ChatService] sendEphemeralImage queue error:', e);
    });
    await this.messageQueue;

    return { messageId: envelopeId, status: finalStatus };
  }

  // ========================================
  // FILE / DOCUMENT MESSAGES
  // ========================================

  /**
   * Send a generic file (document) message.
   * The file is read from disk, AES-encrypted client-side, uploaded to /media
   * (persistent or ephemeral), and a Signal-encrypted envelope is dispatched
   * with `type: 'file'` and a body containing the metadata + decryption keys.
   */
  async sendFileMessage(
    roomId: number,
    file: { uri: string; name: string; mimeType: string; size: number },
    options: { ephemeral?: boolean; ttlHours?: number; parentId?: string; replaceMessageId?: string } = {}
  ): Promise<SendResult> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    if (file.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds maximum allowed size');
    }

    const { ephemeral = false, ttlHours = 24, parentId, replaceMessageId } = options;
    const envelopeId = generateUUID();

    // Persist the source bytes into the chat-files cache up-front. The share
    // extension drops files into a transient AppGroup container that may not
    // survive a retry; copying now guarantees the bubble can re-share/resend
    // the file later even if the upload fails.
    let cachedPath = '';
    try {
      const sourceBase64 = await readFileAsBase64(file.uri);
      cachedPath = saveFileToCache(sourceBase64, envelopeId, file.name);
    } catch (err) {
      logger.warn('[ChatService] sendFile: pre-cache failed, falling back to sourceUri:', err);
    }

    // Optimistic: keep both filePath (stable cache) and sourceUri (best-effort
    // original) so the sender can preview/share immediately.
    const optimisticBody = JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.mimeType,
      sourceUri: file.uri,
      filePath: cachedPath || undefined,
      ephemeral,
    });

    const store = useChatStore.getState();
    const message: Message = {
      id: envelopeId,
      type: UserMessageType.FILE,
      body: optimisticBody,
      encryptedBody: '',
      idRoom: roomId,
      idUserFrom: userId,
      idUserTo: 0,
      timestamp: Date.now(),
      idStatus: MessageStatus.SENDING,
      version: '2.0',
      idParent: parentId || null,
      read: null,
      expiryDatetime: null,
      lastModified: null,
    };
    if (replaceMessageId) {
      store.swapMessage(roomId, replaceMessageId, message);
      await messageRepository.delete(replaceMessageId);
    } else {
      store.addMessage(roomId, message);
    }
    await messageRepository.create(message);

    let finalStatus: MessageStatusType = MessageStatus.SENDING;
    const sendOp = async () => {
      try {
        // 1. Read file as base64. Prefer the cache (stable) over the original
        // sourceUri, which may have been wiped by the share extension.
        const readPath = cachedPath || file.uri;
        const base64 = await readFileAsBase64(readPath);

        // 2. AES-256-GCM encrypt
        const { encryptedBase64, keyBase64, ivBase64 } = await mediaCryptoService.encrypt(base64);

        // 4. Upload (persistent or ephemeral)
        const api = serverRegistry.getApiForRoom(roomId);
        const backendRoomId = toBackendRoomId(roomId);
        const uploadResult = ephemeral
          ? await api.uploadEphemeralMedia(backendRoomId, encryptedBase64, file.mimeType, ttlHours)
          : await api.uploadMedia(backendRoomId, encryptedBase64, file.mimeType);

        // 5. Build envelope payload
        const filePayload: FileMessagePayload = {
          mediaId: uploadResult.mediaId,
          mediaKey: keyBase64,
          iv: ivBase64,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.mimeType,
          ephemeral,
          expiresAt: uploadResult.expiresAt,
        };

        const envelope = MessageEnvelopeFactory.createFileMessage(
          roomId, userId, filePayload, { id_parent: parentId, encrypted: true }
        );
        envelope.id = envelopeId;

        // 6. Update local body to the persisted shape (drop optimistic sourceUri,
        // add cached filePath if available). Sender keeps the file accessible.
        const updatedBody = JSON.stringify({
          ...filePayload,
          filePath: cachedPath,
        });
        await messageRepository.updateBody(envelopeId, updatedBody);
        store.updateMessage(roomId, envelopeId, { body: updatedBody });

        // 7. Signal encrypt + send
        const payloadString = JSON.stringify(envelope.payload);
        const encryptedData = await this.encrypt(roomId, payloadString);
        const serverUserId = serverRegistry.getUserIdForRoom(roomId) || userId;
        const bkRoomId = toBackendRoomId(roomId);

        let serverBody: any;
        let category = envelope.category;

        if (encryptedData.senderKey) {
          category = 'senderkey_message' as const;
          serverBody = {
            id: envelope.id,
            timestamp: envelope.timestamp,
            category: 'senderkey_message',
            type: envelope.type,
            payload: {
              ciphertext: encryptedData.ciphertext,
              distributionId: encryptedData.distributionId,
            },
            id_room: bkRoomId,
            id_user_from: serverUserId,
            version: '2.0',
            id_parent: envelope.id_parent,
          };
        } else {
          serverBody = {
            ...envelope,
            id_room: bkRoomId,
            id_user_from: serverUserId,
            payload: { recipients: encryptedData.recipients },
          };
        }

        const socket = serverRegistry.getSocketForRoom(roomId);
        const result = await this.emitSendMessage(socket, bkRoomId, serverBody, category, envelope.type);

        if (result?.success) {
          await messageRepository.updateStatus(envelopeId, MessageStatus.SENT);
          store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.SENT });
          this.updateRoomAfterMessage(roomId, updatedBody, envelope.type);
          finalStatus = MessageStatus.SENT;
        } else {
          throw new Error(result?.error || 'Send failed');
        }
      } catch (error: any) {
        logger.error('[ChatService] sendFileMessage error:', error?.message || error);
        await messageRepository.updateStatus(envelopeId, MessageStatus.FAILED);
        store.updateMessage(roomId, envelopeId, { idStatus: MessageStatus.FAILED });
        finalStatus = MessageStatus.FAILED;
      }
    };

    this.messageQueue = this.messageQueue.then(sendOp).catch((e) => {
      logger.error('[ChatService] sendFile queue error:', e);
    });
    await this.messageQueue;

    return { messageId: envelopeId, status: finalStatus };
  }

  /**
   * Download an encrypted file blob from the media endpoint, decrypt with the
   * provided AES-GCM key/iv, and persist the plaintext into the chat-files
   * cache. Returns the relative path so the caller can update the message body.
   */
  async downloadAndDecryptFile(
    messageId: string,
    roomId: number,
    payload: FileMessagePayload,
  ): Promise<string> {
    const api = serverRegistry.getApiForRoom(roomId);
    const encryptedArrayBuffer = await api.downloadMedia(payload.mediaId);

    const bytes = new Uint8Array(encryptedArrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const encryptedBase64 = btoa(binary);

    const decryptedBase64 = await mediaCryptoService.decrypt(
      encryptedBase64,
      payload.mediaKey,
      payload.iv,
    );

    const cachedPath = saveFileToCache(decryptedBase64, messageId, payload.fileName);

    const updatedBody = JSON.stringify({
      mediaId: payload.mediaId,
      mediaKey: payload.mediaKey,
      iv: payload.iv,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      mimeType: payload.mimeType,
      ephemeral: payload.ephemeral || false,
      expiresAt: payload.expiresAt,
      filePath: cachedPath,
    });

    await messageRepository.updateBody(messageId, updatedBody);
    useChatStore.getState().updateMessage(roomId, messageId, { body: updatedBody });

    return cachedPath;
  }

  /**
   * Resend an image message (FAILED or UNDELIVERED) with a chosen mode.
   * Deletes the old message, then sends a fresh one.
   */
  async resendMessage(
    roomId: number,
    messageId: string,
    mode: 'volatile' | 'persistent'
  ): Promise<void> {
    const message = await messageRepository.findById(messageId);
    if (!message) throw new Error('Message not found');

    let parsed: any;
    try {
      parsed = JSON.parse(message.body);
    } catch {
      throw new Error('Cannot parse image data');
    }

    let base64: string;
    if (parsed.filePath) {
      base64 = await readImageAsBase64(parsed.filePath);
    } else if (parsed.base64) {
      base64 = parsed.base64;
    } else {
      throw new Error('Image data not available');
    }

    const imagePayload: ImageMessagePayload = {
      base64,
      thumbnail: parsed.thumbnail || '',
      mimeType: parsed.mimeType || 'image/jpeg',
      width: parsed.width || 0,
      height: parsed.height || 0,
      size: parsed.size || 0,
    };

    // Resend with chosen mode — atomic swap prevents scroll position disruption
    if (mode === 'persistent') {
      await this.sendPersistentImageMessage(roomId, imagePayload, message.idParent || undefined, messageId);
    } else {
      await this.sendImageMessage(roomId, imagePayload, message.idParent || undefined, messageId);
    }
  }

  /**
   * Resend a text message (FAILED or UNDELIVERED).
   * Deletes the old message, then sends a fresh one.
   */
  async resendTextMessage(roomId: number, messageId: string): Promise<void> {
    const message = await messageRepository.findById(messageId);
    if (!message) throw new Error('Message not found');

    const body = message.body;
    const parentId = message.idParent || undefined;

    // Resend — atomic swap prevents scroll position disruption
    await this.sendMessage(roomId, body, parentId, messageId);
  }

  /**
   * Resend a generic file message (FAILED or UNDELIVERED).
   * The local cache (`filePath`) is the source of truth — the original
   * `sourceUri` from the share extension may already be gone. We rebuild
   * a file descriptor from the cached blob and re-run sendFileMessage.
   */
  async resendFileMessage(roomId: number, messageId: string): Promise<void> {
    const message = await messageRepository.findById(messageId);
    if (!message) throw new Error('Message not found');

    let parsed: any;
    try {
      parsed = JSON.parse(message.body);
    } catch {
      throw new Error('Cannot parse file message body');
    }

    let uri: string | null = null;
    if (parsed.filePath && fileExists(parsed.filePath)) {
      uri = resolveFilePath(parsed.filePath);
    } else if (parsed.sourceUri) {
      // Last resort: the original share-extension URI. May fail if cleaned up.
      uri = parsed.sourceUri;
    }

    if (!uri) throw new Error('File data not available for resend');

    const fileName: string = parsed.fileName || 'file';
    const mimeType: string = parsed.mimeType || 'application/octet-stream';
    const fileSize: number = typeof parsed.fileSize === 'number' ? parsed.fileSize : 0;
    const ephemeral: boolean = !!parsed.ephemeral;
    const parentId = message.idParent || undefined;

    await this.sendFileMessage(
      roomId,
      { uri, name: fileName, mimeType, size: fileSize },
      { ephemeral, parentId, replaceMessageId: messageId }
    );
  }

  private async sendEnvelope(
    envelope: MessageEnvelope,
    plainBody: string,
    options?: { skipOptimistic?: boolean; localId?: string; replaceMessageId?: string }
  ): Promise<SendResult> {
    const store = useChatStore.getState();
    const roomId = envelope.id_room;

    // Determine if the room uses sender keys — sender key messages get a
    // temporary local ID because the server generates the final UUID.
    const room = await roomRepository.findById(roomId);
    const isSenderKeyRoom = room?.useSenderKeys === 1;
    const localId = options?.localId ?? (isSenderKeyRoom ? generateLocalId() : envelope.id);
    let finalStatus: MessageStatusType = MessageStatus.SENDING;

    if (!options?.skipOptimistic) {
      const message: Message = {
        id: localId,
        type: envelope.type,
        body: plainBody,
        encryptedBody: '',
        idRoom: roomId,
        idUserFrom: envelope.id_user_from,
        idUserTo: envelope.id_user_to || 0,
        timestamp: envelope.timestamp,
        idStatus: MessageStatus.SENDING,
        version: '2.0',
        idParent: envelope.id_parent || null,
        read: null,
        expiryDatetime: null,
        lastModified: null,
      };

      if (options?.replaceMessageId) {
        store.swapMessage(roomId, options.replaceMessageId, message);
        await messageRepository.delete(options.replaceMessageId);
      } else {
        store.addMessage(roomId, message);
      }
      await messageRepository.create(message);
    }

    const sendOperation = async () => {
      let serverBody: any = null;
      let category = envelope.category;
      const isVolatileImage = envelope.type === UserMessageType.IMAGE;

      try {
        const payloadString = JSON.stringify(envelope.payload);
        const encryptedData = await this.encrypt(roomId, payloadString);

        const backendRoomId = toBackendRoomId(roomId);

        // Use server-specific user ID for outgoing messages (different per server)
        const serverUserId = serverRegistry.getUserIdForRoom(roomId) || envelope.id_user_from;

        if (encryptedData.senderKey) {
          category = 'senderkey_message' as const;
          serverBody = {
            id: localId,
            timestamp: envelope.timestamp,
            category: 'senderkey_message',
            type: envelope.type,
            payload: {
              ciphertext: encryptedData.ciphertext,
              distributionId: encryptedData.distributionId,
            },
            id_room: backendRoomId,
            id_user_from: serverUserId,
            version: envelope.version || '2.0',
            id_parent: envelope.id_parent,
          };
        } else {
          serverBody = {
            ...envelope,
            id_room: backendRoomId,
            id_user_from: serverUserId,
            payload: { recipients: encryptedData.recipients },
          };
        }

        // Mark volatile images so the server won't queue for offline recipients
        if (isVolatileImage) {
          serverBody.volatile = true;
        }

        const socket = serverRegistry.getSocketForRoom(roomId);
        logger.info('[ChatService] sendEnvelope: sending message', localId, 'to room', backendRoomId, 'volatile:', isVolatileImage, 'senderKey:', !!encryptedData.senderKey);
        const result = await this.emitSendMessage(socket, backendRoomId, serverBody, category, envelope.type);
        logger.info('[ChatService] sendEnvelope: socket result for', localId, ':', JSON.stringify(result));

        if (result?.success) {
          // Determine effective status: volatile images not delivered → UNDELIVERED
          const effectiveStatus = isVolatileImage && !result.delivered
            ? MessageStatus.UNDELIVERED
            : MessageStatus.SENT;

          if (isSenderKeyRoom && result.messageId) {
            // Server assigned a new UUID — replace the local ID
            const serverTimestamp = result.timestamp ? Number(result.timestamp) : undefined;
            await messageRepository.replaceId(localId, result.messageId, serverTimestamp);
            // replaceId doesn't update idStatus — set it explicitly
            await messageRepository.updateStatus(result.messageId, effectiveStatus);
            store.replaceMessageId(roomId, localId, result.messageId, {
              idStatus: effectiveStatus,
              ...(serverTimestamp ? { timestamp: serverTimestamp } : {}),
            });
          } else {
            await messageRepository.updateStatus(localId, effectiveStatus);
            store.updateMessage(roomId, localId, { idStatus: effectiveStatus });
          }
          finalStatus = effectiveStatus;
          this.updateRoomAfterMessage(roomId, plainBody, envelope.type);
        } else {
          throw new Error(result?.error || 'Send failed - no success in response');
        }
      } catch (error: any) {
        logger.error('[ChatService] sendEnvelope error for', localId, ':', error?.message || error);

        const isTimeout = error?.message?.includes('timeout');
        const isNotConnected = error?.message?.includes('not connected');

        if (isTimeout) {
          logger.warn('[ChatService] Message', localId, 'timed out - keeping as SENDING');
        } else if (isNotConnected && serverBody) {
          logger.info('[ChatService] Not connected, queueing encrypted message', localId);
          queueService.addMessage(serverBody, {
            onSuccess: async (result: any) => {
              const queueEffectiveStatus = isVolatileImage && !result?.delivered
                ? MessageStatus.UNDELIVERED
                : MessageStatus.SENT;

              if (result?.messageId && localId.startsWith('local_')) {
                const serverTimestamp = result.timestamp ? Number(result.timestamp) : undefined;
                await messageRepository.replaceId(localId, result.messageId, serverTimestamp);
                await messageRepository.updateStatus(result.messageId, queueEffectiveStatus);
                store.replaceMessageId(roomId, localId, result.messageId, {
                  idStatus: queueEffectiveStatus,
                  ...(serverTimestamp ? { timestamp: serverTimestamp } : {}),
                });
              } else {
                await messageRepository.updateStatus(localId, queueEffectiveStatus);
                store.updateMessage(roomId, localId, { idStatus: queueEffectiveStatus });
              }
            },
            onError: async () => {
              await messageRepository.updateStatus(localId, MessageStatus.FAILED);
              store.updateMessage(roomId, localId, { idStatus: MessageStatus.FAILED });
            },
          });
        } else {
          logger.error('[ChatService] Message', localId, 'failed:', error?.message);
          await messageRepository.updateStatus(localId, MessageStatus.FAILED);
          store.updateMessage(roomId, localId, { idStatus: MessageStatus.FAILED });
          finalStatus = MessageStatus.FAILED;
        }
      }
    };

    this.messageQueue = this.messageQueue
      .then(sendOperation)
      .catch((error) => {
        logger.error('[ChatService] sendEnvelope queue error:', error);
      });
    await this.messageQueue;

    return { messageId: localId, status: finalStatus };
  }

  // ========================================
  // CONTROL PACKET SENDING
  // ========================================

  async sendControlPacket(
    roomId: number,
    type: ControlPacketTypeValue,
    payload: any,
    toUserId?: number,
    options?: { inline?: boolean }
  ): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) {
      logger.warn('[ChatService] sendControlPacket: no userId, skipping');
      return;
    }

    const envelope = MessageEnvelopeFactory.createControlPacket(roomId, userId, type, payload);
    logger.info(`[ChatService][User:${userId}] sendControlPacket: ${type} id: ${envelope.id} room: ${roomId} to: ${toUserId} inline: ${!!options?.inline}`);

    // Per-device fan-out recipients (pair-wise path). When set, the network
    // step emits `recipients[]` top-level instead of a single envelope so
    // every (userId, deviceId) of the room — including the sender's own
    // linked devices — receives its own ciphertext. The legacy single-
    // broadcast path drops the receipt on the sender's other devices
    // because the backend filter matches by `userId` only (frontend-0019).
    let perDeviceRecipients: Array<{ userId: number; deviceId: number; ciphertext: string }> | null = null;

    // The Signal Protocol encrypt is the ONLY part that must run serialized
    // on the messageQueue. Returns false to drop the packet.
    const encryptStep = async (): Promise<boolean> => {
      logger.info(`[ChatService][User:${userId}] sendControlPacket EXECUTING: ${type} id: ${envelope.id}`);
      if (envelope.encrypted) {
        try {
          const encrypted = await this.encrypt(roomId, JSON.stringify(payload));
          if (encrypted.senderKey) {
            // Sender-key control packets stay on the legacy broadcast path:
            // there is a single ciphertext decryptable by every group member.
            envelope.payload = {
              ciphertext: encrypted.ciphertext,
              distributionId: encrypted.distributionId,
            };
          } else if (encrypted.recipients) {
            // Pair-wise: capture per-device recipients for the fan-out wire
            // shape. We deliberately do NOT set `envelope.payload` to the
            // recipients array — that's the buggy nested shape that falls
            // onto the legacy broadcast path.
            perDeviceRecipients = encrypted.recipients;
          }
          logger.info('[ChatService] sendControlPacket: encrypted OK, senderKey:', !!encrypted.senderKey, 'perDevice:', perDeviceRecipients?.length ?? 0);
        } catch (error) {
          logger.error('[ChatService] Control packet encryption failed, dropping packet:', error);
          return false;
        }
      } else {
        envelope.payload = { body: JSON.stringify(payload) };
      }

      if (toUserId) {
        envelope.id_user_to = toUserId;
      }

      // Use server-specific user ID for outgoing packets
      const serverUserId = serverRegistry.getUserIdForRoom(roomId);
      if (serverUserId) {
        envelope.id_user_from = serverUserId;
      }
      return true;
    };

    // The network emit runs DETACHED from the messageQueue. The backend ack
    // for a control packet can take seconds (backend-0015); awaiting it on
    // the serial queue would head-of-line-block real message sends behind it
    // (frontend-0015 A). Control packets are best-effort — the ack result is
    // only logged, and the receiver dedups duplicates by status.
    const networkStep = (): void => {
      const socket = serverRegistry.getSocketForRoom(roomId);
      if (!socket.isConnected()) {
        logger.warn('[ChatService] sendControlPacket: socket NOT connected, dropping packet');
        return;
      }
      const backendRoomId = toBackendRoomId(roomId);
      const isVolatile = type === ControlPacketType.TYPING_STARTED || type === ControlPacketType.TYPING_STOPPED;

      if (perDeviceRecipients && perDeviceRecipients.length > 0) {
        // New wire shape (frontend-0019): one packet per (userId, deviceId),
        // emitted top-level so the backend routes to fanOutPacketToRecipients
        // and saves per-device pending rows for offline targets. Contract:
        // _shared/specs/multidevice-send-wire-shape.md § "Control packets".
        const fanoutRecipients: PacketRecipientFanout[] = perDeviceRecipients.map((rcp) => ({
          userId: rcp.userId,
          deviceId: rcp.deviceId,
          packet: {
            id: envelope.id,
            timestamp: envelope.timestamp,
            category: envelope.category,
            type: envelope.type,
            payload: { ciphertext: rcp.ciphertext },
            id_room: envelope.id_room,
            id_user_from: envelope.id_user_from,
            id_user_to: rcp.userId,
            encrypted: true,
            version: envelope.version,
          },
        }));
        socket
          .sendPacket({ roomId: backendRoomId, recipients: fanoutRecipients, volatile: isVolatile })
          .then((result) => {
            logger.info('[ChatService] sendControlPacket: fan-out sent, result:', JSON.stringify(result));
          })
          .catch((error) => {
            logger.error('[ChatService] sendControlPacket fan-out network error:', error);
          });
        return;
      }

      // Legacy path: single envelope, broadcast by userId. Used by the
      // sender-key encrypted ramo and the unencrypted body ramo.
      socket
        .sendPacket(backendRoomId, envelope, toUserId ? [toUserId] : undefined, isVolatile)
        .then((result) => {
          logger.info('[ChatService] sendControlPacket: sent, result:', JSON.stringify(result));
        })
        .catch((error) => {
          logger.error('[ChatService] sendControlPacket network error:', error);
        });
    };

    const prepareAndSend = async (): Promise<void> => {
      const ready = await encryptStep();
      if (ready) networkStep();
    };

    if (options?.inline) {
      // SAFETY: inline must only be called from within the messageQueue chain
      // (processEnvelope → handleUserMessage, enqueueSignalOperation → joinRoom)
      // to avoid concurrent Signal Protocol operations. Only the encrypt is
      // awaited here; the network emit is fired detached.
      try {
        await prepareAndSend();
      } catch (error) {
        logger.error('[ChatService] sendControlPacket inline error:', error);
      }
    } else {
      // Enqueue ONLY the encrypt; the network emit fires detached so a slow
      // backend ack never blocks the message sends queued after it.
      this.messageQueue = this.messageQueue
        .then(prepareAndSend)
        .catch((error) => {
          logger.error('[ChatService] sendControlPacket queue error:', error);
        });
    }
  }

  // ========================================
  // TYPING INDICATORS
  // ========================================

  sendTypingIndicator(roomId: number): void {
    const now = Date.now();
    const lastSent = this.typingThrottleMap.get(roomId) || 0;
    if (now - lastSent < TYPING_THROTTLE_MS) return;

    this.typingThrottleMap.set(roomId, now);
    this.typingActiveRooms.add(roomId);
    this.sendControlPacket(roomId, ControlPacketType.TYPING_STARTED, {}).catch((err) => {
      logger.warn('[ChatService] sendTypingIndicator error:', err);
    });
  }

  sendTypingStopped(roomId: number): void {
    // Only emit a stop if we actually announced typing, and emit it at most
    // once per burst. Crucially, do NOT clear `typingThrottleMap` here: doing
    // so lets the very next keystroke re-arm a full typing_start, defeating
    // the throttle (frontend-0015 D).
    if (!this.typingActiveRooms.has(roomId)) return;
    this.typingActiveRooms.delete(roomId);
    this.sendControlPacket(roomId, ControlPacketType.TYPING_STOPPED, {}).catch((err) => {
      logger.warn('[ChatService] sendTypingStopped error:', err);
    });
  }

  // ========================================
  // ROOM MANAGEMENT
  // ========================================

  async createRoom(
    name: string,
    username: string,
    serverId?: number,
    administered?: boolean
  ): Promise<{ roomId: number; inviteCode: string }> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    const targetServerId = serverId ?? serverRegistry.getDefaultServerId();
    const api = serverRegistry.getApi(targetServerId);

    const res = await api.createRoom(name, username, administered);
    const localRoomId = toLocalRoomId(targetServerId, res.roomId);

    await roomRepository.upsert({
      id: localRoomId,
      name,
      inviteCode: res.inviteCode,
      status: 0,
      idUser: userId,
      useSenderKeys: 0,
      administered: administered ? 1 : 0,
      serverId: targetServerId,
    });

    await profileRepository.upsert({
      idUser: userId,
      idRoom: localRoomId,
      username,
    });

    // Also store profile with server-specific userId
    const srvUserId = serverRegistry.getUserIdForServer(targetServerId);
    if (srvUserId && srvUserId !== userId) {
      await profileRepository.upsert({
        idUser: srvUserId,
        idRoom: localRoomId,
        username,
      });
    }

    const store = useChatStore.getState();
    store.addRoomToList({
      id: localRoomId,
      name,
      inviteCode: res.inviteCode,
      status: 0,
      idUser: userId,
      useSenderKeys: 0,
      administered: administered ? 1 : 0,
      serverId: targetServerId,
      username: null,
      image: null,
      age: null,
      timestampUpdate: null,
      timestampCreate: Math.floor(Date.now() / 1000),
      lastModified: Math.floor(Date.now() / 1000),
      hasSession: false,
      unreadCount: 0,
    });

    const socket = serverRegistry.getSocket(targetServerId);
    await socket.joinRoom(res.roomId);

    return { roomId: localRoomId, inviteCode: res.inviteCode.toUpperCase() };
  }

  async joinRoom(inviteCode: string, username: string, serverId?: number): Promise<number> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    const targetServerId = serverId ?? serverRegistry.getDefaultServerId();
    const api = serverRegistry.getApi(targetServerId);

    const code = inviteCode.trim().toLowerCase();
    logger.info('[ChatService] joinRoom: calling API with code', code, 'on server', targetServerId);
    const res = await api.joinRoom(code, username);
    logger.info('[ChatService] joinRoom: API response', JSON.stringify(res));

    const localRoomId = toLocalRoomId(targetServerId, res.roomId);

    await roomRepository.upsert({
      id: localRoomId,
      name: res.name,
      inviteCode: res.inviteCode,
      status: res.status ?? 0,
      idUser: res.id_user,
      useSenderKeys: res.useSenderKeys ?? 0,
      administered: res.administered ? 1 : 0,
      serverId: targetServerId,
    });

    await profileRepository.upsert({
      idUser: userId,
      idRoom: localRoomId,
      username,
    });

    // Also store profile with server-specific userId for profile lookups
    // from other devices (they see us with server-specific ID)
    const serverUserId = serverRegistry.getUserIdForServer(targetServerId);
    if (serverUserId && serverUserId !== userId) {
      await profileRepository.upsert({
        idUser: serverUserId,
        idRoom: localRoomId,
        username,
      });
    }

    logger.info('[ChatService] joinRoom: fetching members for room', res.roomId, 'on server', targetServerId);
    const members = await api.getRoomMembers(res.roomId);
    const serverUserId2 = serverRegistry.getUserIdForServer(targetServerId);
    logger.info('[ChatService] joinRoom: found', members.length, 'members, serverUserId:', serverUserId2, 'globalUserId:', userId);
    for (const m of members) {
      logger.info('[ChatService] joinRoom: member:', JSON.stringify({ id_user: m.id_user, username: m.username }));
    }

    const hasSession = await this.enqueueSignalOperation(async () => {
      let anySession = false;

      for (const member of members) {
        try {
          logger.info('[ChatService] joinRoom: establishing session with member', member.id_user, 'in room', localRoomId);
          const success = await sessionService.setSession(
            localRoomId,
            member.id_user,
            member.username || `user-${member.id_user}`,
            1
          );
          logger.info('[ChatService] joinRoom: setSession result for member', member.id_user, ':', success);
          if (success) anySession = true;

          await profileRepository.upsert({
            idUser: member.id_user,
            idRoom: localRoomId,
            username: member.username || `user-${member.id_user}`,
          });
        } catch (error) {
          logger.error('[ChatService] Session with member failed:', member.id_user, error);
        }
      }

      // Verify sessions in DB after establishment
      const sessionsInDb = await sessionRepository.findByRoom(localRoomId);
      logger.info('[ChatService] joinRoom: sessions done, hasSession:', anySession, 'sessionsInDb:', sessionsInDb.length,
        'sessionDetails:', sessionsInDb.map(s => ({ idUser: s.idUser, idRoom: s.idRoom })));

      // Notify existing members so they can establish the reverse session.
      // This is a targeted packet — the decrypt on the receiver's side
      // auto-establishes the session via PreKeySignalMessage (X3DH).
      for (const member of members) {
        try {
          await this.sendControlPacket(
            localRoomId,
            ControlPacketType.SESSION_ESTABLISHED,
            { timestamp: Date.now(), username },
            member.id_user,
            { inline: true }
          );
        } catch (error) {
          logger.warn('[ChatService] Failed to notify member:', member.id_user, error);
        }
      }

      const totalMembers = members.length + 1;
      if (totalMembers >= SENDER_KEY_THRESHOLD) {
        try {
          await senderKeyService.fetchAndProcessPendingSenderKeys(localRoomId);
          await senderKeyService.initializeSenderKeysIfNeeded(localRoomId);
        } catch (error) {
          logger.error('[ChatService] Sender key setup failed:', error);
        }
      }

      return anySession;
    });

    logger.info('[ChatService] joinRoom: adding room to store, id:', localRoomId, 'name:', res.name);
    const store = useChatStore.getState();
    store.addRoomToList({
      id: localRoomId,
      name: res.name,
      inviteCode: res.inviteCode,
      status: 0,
      idUser: res.id_user,
      useSenderKeys: res.useSenderKeys ?? 0,
      administered: res.administered ? 1 : 0,
      serverId: targetServerId,
      username: null,
      image: null,
      age: null,
      timestampUpdate: null,
      timestampCreate: Math.floor(Date.now() / 1000),
      lastModified: Math.floor(Date.now() / 1000),
      hasSession,
      unreadCount: 0,
    });

    const socket = serverRegistry.getSocket(targetServerId);
    await socket.joinRoom(res.roomId);

    logger.info('[ChatService] joinRoom: complete, store allRooms:', useChatStore.getState().allRooms.length);

    return localRoomId;
  }

  async deleteRoom(roomId: number): Promise<'deleted' | 'left'> {
    const api = serverRegistry.getApiForRoom(roomId);
    const backendRoomId = toBackendRoomId(roomId);

    let action: 'deleted' | 'left' = 'deleted';
    try {
      const res = await api.deleteRoom(backendRoomId);
      if (res?.action === 'left') action = 'left';
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        logger.info('[ChatService] deleteRoom: room already deleted on server, proceeding with local cleanup');
      } else {
        throw error;
      }
    }

    await this.performLocalRoomCleanup(roomId);
    return action;
  }

  async deleteMessageForEveryone(roomId: number, messageId: string): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) throw new Error('Not authenticated');

    const message = await messageRepository.findById(messageId);
    if (!message) throw new Error('Message not found');

    const api = serverRegistry.getApiForRoom(roomId);
    const backendRoomId = toBackendRoomId(roomId);
    await api.deleteMessage(backendRoomId, messageId);

    if (message.type === UserMessageType.IMAGE || message.type === UserMessageType.PERSISTENT_IMAGE || message.type === UserMessageType.EPHEMERAL_IMAGE) {
      deleteImagesByMessageIds([messageId]);
    }

    if (message.type === UserMessageType.PERSISTENT_IMAGE || message.type === UserMessageType.EPHEMERAL_IMAGE) {
      try {
        const parsed = JSON.parse(message.body);
        if (parsed.mediaId) {
          const mediaApi = serverRegistry.getApiForRoom(roomId);
          await mediaApi.deleteMedia(parsed.mediaId);
        }
      } catch (e) {
        logger.warn('[ChatService] deleteMedia failed (non-critical):', e);
      }
    }

    await messageRepository.delete(messageId);
    useChatStore.getState().removeMessage(roomId, messageId);
    await this.refreshRoomLastMessage(roomId);
  }

  // ========================================
  // RECEIPTS
  // ========================================

  async sendReadReceipt(
    roomId: number,
    messageIds: string | string[],
    toUserId: number
  ): Promise<void> {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    if (ids.length === 0) return;

    // One id → keep the legacy `{ id_message }` shape. Multiple → coalesce
    // into a single packet with `id_messages[]`, keeping `id_message` set to
    // the last id so an older peer still marks at least that one read
    // (frontend-0015 B). Contract: _shared/api/control-packet-read-coalesced.md
    const payload =
      ids.length === 1
        ? { id_message: ids[0] }
        : { id_message: ids[ids.length - 1], id_messages: ids };

    await this.sendControlPacket(roomId, ControlPacketType.MESSAGE_READ, payload, toUserId);
  }

  async markRoomAsRead(roomId: number): Promise<number> {
    const userId = useAuthStore.getState().userId;
    if (!userId) return 0;

    const messages = useChatStore.getState().messages.get(roomId) || [];
    // Only messages from others not yet at READ — this filter also guards
    // against re-sending a READ for a message already >= READ
    // (frontend-0015 C / AC #3).
    const unread = messages.filter(
      (m) => m.idUserFrom !== userId && m.idStatus !== MessageStatus.READ
    );

    if (unread.length === 0) return 0;

    // Coalesce: one READ packet per sender carrying all of that sender's
    // unread message ids, instead of one packet per message (frontend-0015 B).
    // In group rooms different messages have different senders, so the
    // grouping key is `idUserFrom`.
    const idsBySender = new Map<number, string[]>();
    for (const msg of unread) {
      const list = idsBySender.get(msg.idUserFrom) ?? [];
      list.push(msg.id);
      idsBySender.set(msg.idUserFrom, list);
    }

    for (const [senderId, ids] of idsBySender) {
      try {
        await this.sendReadReceipt(roomId, ids, senderId);
      } catch (error) {
        logger.error('[ChatService] Failed to send read receipt to:', senderId);
      }
    }

    // Mark local state regardless of receipt-delivery outcome. The receipt
    // itself is fire-and-forget; what matters locally is the badge clearing
    // and the bubble checkmark.
    for (const msg of unread) {
      await messageRepository.markAsRead(msg.id);
      useChatStore.getState().updateMessage(roomId, msg.id, { idStatus: MessageStatus.READ });
    }

    useChatStore.getState().updateRoomInList(roomId, { unreadCount: 0 });
    // frontend-0020 — opening the room locally zeroed the room counter but
    // the OS badge was only refreshed on next foreground. Recompute the
    // total now so the lockscreen number drops immediately.
    await this.refreshOsBadge();

    return unread.length;
  }

  /**
   * Recompute the unread counter for a single room by querying the DB.
   * Used after a self-fanout MESSAGE_READ stamps `read` on incoming rows
   * (frontend-0020). The DB recompute is the robust invariant — decrementing
   * by the count of just-applied rows races with `handleUserMessage` which
   * increments the counter from a different code path.
   */
  private async recomputeRoomUnread(roomId: number): Promise<void> {
    const selfUserId = useAuthStore.getState().userId;
    const serverUserId = serverRegistry.getUserIdForRoom(roomId);
    const exclude: number[] = [];
    if (selfUserId != null) exclude.push(selfUserId);
    if (serverUserId != null && serverUserId !== selfUserId) exclude.push(serverUserId);
    try {
      const newUnread = await messageRepository.countUnreadIncoming(roomId, exclude);
      useChatStore.getState().updateRoomInList(roomId, { unreadCount: newUnread });
    } catch (err) {
      logger.warn('[ChatService] recomputeRoomUnread failed:', err);
    }
  }

  /**
   * Refresh the OS badge to the sum of unread counts across all rooms in
   * the store. Lazy-required to keep tests / non-Notifications builds
   * happy and to avoid pulling in expo-notifications at module load.
   *
   * Debounced (M8): a single MESSAGE_READ self-fanout can fire `markAsRead`
   * + `recomputeRoomUnread` + `refreshOsBadge` while the user is also
   * tapping a room locally (which runs its own `markRoomAsRead` →
   * `refreshOsBadge`). Both producers land on the same total but the OS
   * badge would flicker between the intermediate and final values.
   * Coalesce all calls within a 50ms window into the LATEST store state so
   * `setBadgeCountAsync` only fires once with the converged total.
   *
   * Every caller's promise is parked in `badgeRefreshResolvers` and
   * resolved together when the timer fires — `await refreshOsBadge()`
   * therefore still waits for `setBadgeCountAsync` to complete, which the
   * tests rely on.
   */
  private badgeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeRefreshResolvers: Array<() => void> = [];
  private async refreshOsBadge(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.badgeRefreshResolvers.push(resolve);
      if (this.badgeRefreshTimer) {
        clearTimeout(this.badgeRefreshTimer);
      }
      this.badgeRefreshTimer = setTimeout(async () => {
        this.badgeRefreshTimer = null;
        const resolvers = this.badgeRefreshResolvers;
        this.badgeRefreshResolvers = [];
        try {
          const total = useChatStore
            .getState()
            .allRooms.reduce((sum, r) => sum + (r.unreadCount ?? 0), 0);
          const Notifications = require('expo-notifications');
          await Notifications.setBadgeCountAsync(Math.max(0, total));
        } catch (err) {
          logger.warn('[ChatService] refreshOsBadge failed:', err);
        }
        for (const r of resolvers) r();
      }, 50);
    });
  }

  // ========================================
  // RECOVERY
  // ========================================

  async recoverStuckMessages(): Promise<void> {
    const MAX_RETRY_AGE_MS = 2 * 60 * 60 * 1000;
    const cutoff = Date.now() - MAX_RETRY_AGE_MS;

    try {
      const stuck = await messageRepository.findStuckSending();
      let expired = 0;
      let retryable = 0;

      for (const msg of stuck) {
        if (msg.timestamp < cutoff) {
          await messageRepository.updateStatus(msg.id, MessageStatus.FAILED);
          expired++;
        } else {
          retryable++;
        }
      }

      if (expired > 0 || retryable > 0) {
        logger.info(
          `[ChatService] recoverStuckMessages: ${expired} expired -> FAILED, ${retryable} retryable (will retry on connect)`
        );
      }
    } catch (error) {
      logger.warn('[ChatService] recoverStuckMessages error:', error);
    }
  }

  private async retrySendingMessages(): Promise<void> {
    const MAX_RETRY_AGE_MS = 2 * 60 * 60 * 1000;
    const cutoff = Date.now() - MAX_RETRY_AGE_MS;

    const stuck = await messageRepository.findStuckSending();
    const retryable = stuck.filter((m) => m.timestamp >= cutoff);
    if (retryable.length === 0) return;

    logger.info(`[ChatService] Retrying ${retryable.length} stuck messages...`);

    for (const msg of retryable) {
      await this.retryMessageSend(msg);
    }
  }

  private async retryMessageSend(msg: Message): Promise<void> {
    const store = useChatStore.getState();
    const isLocalId = msg.id.startsWith('local_');

    const retryOp = async () => {
      try {
        const payload = this.reconstructPayload(msg.type, msg.body);
        const payloadString = JSON.stringify(payload);

        const encryptedData = await this.encrypt(msg.idRoom, payloadString);
        const backendRoomId = toBackendRoomId(msg.idRoom);

        let serverBody: any;
        let category: string;

        const retryIsVolatileImage = msg.type === UserMessageType.IMAGE;

        if (encryptedData.senderKey) {
          category = 'senderkey_message';
          serverBody = {
            id: msg.id,
            timestamp: msg.timestamp,
            category: 'senderkey_message',
            type: msg.type,
            payload: {
              ciphertext: encryptedData.ciphertext,
              distributionId: encryptedData.distributionId,
            },
            id_room: backendRoomId,
            id_user_from: msg.idUserFrom,
            version: msg.version || '2.0',
            id_parent: msg.idParent,
          };
        } else {
          category = 'user';
          serverBody = {
            id: msg.id,
            timestamp: msg.timestamp,
            category: 'user',
            type: msg.type,
            payload: { recipients: encryptedData.recipients },
            id_room: backendRoomId,
            id_user_from: msg.idUserFrom,
            encrypted: true,
            version: msg.version || '2.0',
            id_parent: msg.idParent,
          };
        }

        // Mark volatile images so the server won't queue for offline recipients
        if (retryIsVolatileImage) {
          serverBody.volatile = true;
        }

        const socket = serverRegistry.getSocketForRoom(msg.idRoom);
        const result = await this.emitSendMessage(socket, backendRoomId, serverBody, category, msg.type);

        if (result?.success) {
          const retryEffectiveStatus = retryIsVolatileImage && !result.delivered
            ? MessageStatus.UNDELIVERED
            : MessageStatus.SENT;

          if (isLocalId && result.messageId) {
            const serverTimestamp = result.timestamp ? Number(result.timestamp) : undefined;
            await messageRepository.replaceId(msg.id, result.messageId, serverTimestamp);
            await messageRepository.updateStatus(result.messageId, retryEffectiveStatus);
            store.replaceMessageId(msg.idRoom, msg.id, result.messageId, {
              idStatus: retryEffectiveStatus,
              ...(serverTimestamp ? { timestamp: serverTimestamp } : {}),
            });
          } else {
            await messageRepository.updateStatus(msg.id, retryEffectiveStatus);
            store.updateMessage(msg.idRoom, msg.id, { idStatus: retryEffectiveStatus });
          }
          logger.info(`[ChatService] Retry success: ${msg.id}`);
        } else {
          throw new Error(result?.error || 'Send failed');
        }
      } catch (error: any) {
        logger.error(`[ChatService] Retry failed for ${msg.id}:`, error?.message || error);
        await messageRepository.updateStatus(msg.id, MessageStatus.FAILED);
        store.updateMessage(msg.idRoom, msg.id, { idStatus: MessageStatus.FAILED });
      }
    };

    this.messageQueue = this.messageQueue.then(retryOp).catch((error) => {
      logger.error('[ChatService] retryMessageSend queue error:', error);
    });
    await this.messageQueue;
  }

  private reconstructPayload(type: string, body: string): any {
    switch (type) {
      case UserMessageType.TEXT:
        return { text: body };
      case UserMessageType.PERSISTENT_IMAGE:
        try {
          return JSON.parse(body);
        } catch {
          return { text: body };
        }
      case UserMessageType.IMAGE:
      case UserMessageType.EPHEMERAL_IMAGE:
      case UserMessageType.AUDIO:
      case UserMessageType.VIDEO:
      case UserMessageType.FILE:
      case UserMessageType.LOCATION:
        try {
          return JSON.parse(body);
        } catch {
          return { text: body };
        }
      default:
        return { text: body };
    }
  }

  // ========================================
  // ROOMS LOADING
  // ========================================

  async loadRooms(): Promise<void> {
    const userId = useAuthStore.getState().userId;
    if (!userId) return;

    const rooms = await roomRepository.findAllWithMetadata(userId);

    const enrichedRooms = await Promise.all(
      rooms.map(async (room) => {
        const lastMessages = await messageRepository.findByRoom(room.id, { limit: 1 });
        const lastMsg = lastMessages[0];
        return {
          ...room,
          lastMessageText: lastMsg?.body || undefined,
          lastMessageType: lastMsg?.type || undefined,
          hasSession: room.hasSession ? true : false,
        };
      })
    );

    useChatStore.getState().setAllRooms(enrichedRooms);
  }

  async loadRoomMessages(roomId: number): Promise<void> {
    const messages = await messageRepository.findByRoom(roomId, { limit: PAGE_SIZE });
    const sorted = messages.reverse();

    useChatStore.getState().setMessages(roomId, sorted);

    useChatStore.getState().setPaginationState(roomId, {
      hasMore: messages.length >= PAGE_SIZE,
      oldestTimestamp: sorted.length > 0 ? sorted[0].timestamp : null,
      isLoadingMore: false,
    });
  }

  async loadMoreMessages(roomId: number, beforeTimestamp: number): Promise<void> {
    const messages = await messageRepository.findByRoom(roomId, {
      limit: PAGE_SIZE,
      beforeTimestamp,
    });

    const store = useChatStore.getState();

    if (messages.length === 0) {
      store.setPaginationState(roomId, { hasMore: false, isLoadingMore: false });
      return;
    }

    const sorted = messages.reverse();
    store.prependMessages(roomId, sorted);

    store.setPaginationState(roomId, {
      hasMore: messages.length >= PAGE_SIZE,
      oldestTimestamp: sorted[0].timestamp,
      isLoadingMore: false,
    });
  }

  async loadRoomProfiles(roomId: number): Promise<void> {
    const profiles = await profileRepository.findByRoom(roomId);
    useChatStore.getState().setProfiles(roomId, profiles);
  }

  async loadAllRoomProfiles(): Promise<void> {
    const rooms = useChatStore.getState().allRooms;
    for (const room of rooms) {
      const profiles = await profileRepository.findByRoom(room.id);
      useChatStore.getState().setProfiles(room.id, profiles);
    }
  }

  // ========================================
  // HELPERS
  // ========================================

  private extractUserBody(type: UserMessageTypeValue, payload: any): string {
    switch (type) {
      case UserMessageType.TEXT:
        return payload?.text || '';
      case UserMessageType.IMAGE:
      case UserMessageType.PERSISTENT_IMAGE:
      case UserMessageType.EPHEMERAL_IMAGE:
      case UserMessageType.FILE:
        return JSON.stringify(payload || {});
      case UserMessageType.AUDIO:
      case UserMessageType.VIDEO:
      case UserMessageType.LOCATION:
        return payload?.base64 || payload?.url || JSON.stringify(payload || {});
      default:
        return payload?.text || JSON.stringify(payload || {});
    }
  }

  private async refreshRoomLastMessage(roomId: number): Promise<void> {
    const lastMessages = await messageRepository.findByRoom(roomId, { limit: 1 });
    const lastMsg = lastMessages[0];
    useChatStore.getState().updateRoomInList(roomId, {
      lastMessageText: lastMsg?.body || undefined,
      lastMessageType: lastMsg?.type || undefined,
      lastMessageTime: lastMsg?.timestamp || null,
    });
  }

  /**
   * Full local cleanup for a deleted room. Each step is independent
   * so a failure in one doesn't block the others.
   */
  private async handleUserLeftRoom(roomId: number, userId: number): Promise<void> {
    const ownUserId = useAuthStore.getState().userId;

    if (userId === ownUserId) {
      // Current user left the room — full cleanup
      await this.performLocalRoomCleanup(roomId);
      return;
    }

    // Another user left — remove their messages and profile
    try {
      await messageRepository.deleteByUserInRoom(roomId, userId);
    } catch (e) {
      logger.warn('[ChatService] handleUserLeftRoom: deleteByUserInRoom failed:', e);
    }

    try {
      await profileRepository.deleteByUserAndRoom(userId, roomId);
    } catch (e) {
      logger.warn('[ChatService] handleUserLeftRoom: deleteByUserAndRoom failed:', e);
    }

    useChatStore.getState().removeProfile(roomId, userId);

    // Reload messages in memory to reflect removal
    await this.loadRoomMessages(roomId);
  }

  private async performLocalRoomCleanup(roomId: number): Promise<void> {
    logger.info('[ChatService] performLocalRoomCleanup:', roomId);

    try { await this.deleteRoomImages(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup deleteRoomImages failed:', e); }

    try { queueService.removeMessagesByRoom(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup removeMessagesByRoom failed:', e); }

    try { await roomRepository.hardDelete(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup hardDelete failed:', e); }

    try { await sessionService.deleteSessionsByRoom(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup deleteSessionsByRoom failed:', e); }

    try { await senderKeyRepository.deleteSessionsByRoom(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup deleteSessionsByRoom (senderKey) failed:', e); }

    try { await senderKeyRepository.clearRetryQueueByRoom(roomId); }
    catch (e) { logger.warn('[ChatService] cleanup clearRetryQueueByRoom failed:', e); }

    useChatStore.getState().removeRoomFromList(roomId);
    useChatStore.getState().clearRoom(roomId);
  }

  private async deleteRoomImages(roomId: number): Promise<void> {
    try {
      const imageMessages = await messageRepository.findByRoomAndType(roomId, UserMessageType.IMAGE);
      const persistentImageMessages = await messageRepository.findByRoomAndType(roomId, UserMessageType.PERSISTENT_IMAGE);
      const allImageMessages = [...imageMessages, ...persistentImageMessages];
      if (allImageMessages.length > 0) {
        deleteImagesByMessageIds(allImageMessages.map((m) => m.id));
        logger.info('[ChatService] Deleted', allImageMessages.length, 'image files for room', roomId);
      }
    } catch (error) {
      logger.warn('[ChatService] deleteRoomImages error:', error);
    }

    try {
      const fileMessages = await messageRepository.findByRoomAndType(roomId, UserMessageType.FILE);
      if (fileMessages.length > 0) {
        deleteFilesByMessageIds(fileMessages.map((m) => m.id));
        logger.info('[ChatService] Deleted', fileMessages.length, 'cached files for room', roomId);
      }
    } catch (error) {
      logger.warn('[ChatService] deleteRoomFiles error:', error);
    }
  }

  private async downloadAndDecryptPersistentImage(
    messageId: string,
    roomId: number,
    payload: PersistentImagePayload
  ): Promise<void> {
    try {
      logger.info('[ChatService] Persistent image download starting:', messageId, payload.mediaId);

      const api = serverRegistry.getApiForRoom(roomId);
      const encryptedArrayBuffer = await api.downloadMedia(payload.mediaId);
      logger.info('[ChatService] Persistent image downloaded, size:', encryptedArrayBuffer.byteLength);

      // Convert ArrayBuffer to base64 for the native decrypt function
      const bytes = new Uint8Array(encryptedArrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const encryptedBase64 = btoa(binary);

      // Decrypt using native platform crypto (returns base64)
      const base64Image = await mediaCryptoService.decrypt(encryptedBase64, payload.mediaKey, payload.iv);
      logger.info('[ChatService] Persistent image decrypted, base64 length:', base64Image.length);

      // Save to filesystem
      const filePath = await saveImageToFile(base64Image, messageId, payload.mimeType);
      logger.info('[ChatService] Persistent image saved to:', filePath);

      // Update body with filePath (same format as volatile images after persist)
      const updatedBody = JSON.stringify({
        filePath,
        thumbnail: payload.thumbnail || '',
        width: payload.width,
        height: payload.height,
        mimeType: payload.mimeType,
      });

      await messageRepository.updateBody(messageId, updatedBody);
      useChatStore.getState().updateMessage(roomId, messageId, { body: updatedBody });

      logger.info('[ChatService] Persistent image body updated in store:', messageId);
    } catch (error: any) {
      logger.error('[ChatService] Persistent image download/decrypt FAILED:', messageId, error?.message || error);
      if (error?.response?.status === 404 || error?.message?.includes('expired')) {
        logger.warn('[ChatService] Persistent image expired or not found:', payload.mediaId);
      } else {
        throw error;
      }
    }
  }

  private async persistImageToFilesystem(
    messageId: string,
    roomId: number,
    payload: ImageMessagePayload
  ): Promise<void> {
    if (!payload.base64) return;

    try {
      const filePath = await saveImageToFile(payload.base64, messageId, payload.mimeType);

      const lightBody = JSON.stringify({
        filePath,
        thumbnail: payload.thumbnail || '',
        width: payload.width,
        height: payload.height,
        mimeType: payload.mimeType,
      });

      await messageRepository.updateBody(messageId, lightBody);
      useChatStore.getState().updateMessage(roomId, messageId, { body: lightBody });

      logger.info('[ChatService] Image persisted to filesystem:', filePath);
    } catch (error) {
      logger.warn('[ChatService] persistImageToFilesystem error:', error);
    }
  }

  private updateRoomAfterMessage(roomId: number, body: string, type?: string): void {
    const store = useChatStore.getState();
    store.updateRoomInList(roomId, {
      lastMessageTime: Date.now(),
      lastMessageText: body,
      lastMessageType: type,
    });
  }
}

export const chatService = new ChatService();
export default chatService;
