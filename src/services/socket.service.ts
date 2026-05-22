import { io, Socket } from 'socket.io-client';
import { logger } from '@/utils/logger';
import { MessageEnvelope, generateUUID } from '@/types/message';
import { SocketConnectionState } from '@/types/connection';
import { useServerStore } from '@/stores/server.store';
import { TorWebSocket } from './tor-websocket';

// Re-export so existing `import { SocketConnectionState } from './socket.service'` still works
export { SocketConnectionState } from '@/types/connection';

// Socket events
export const CHAT_EVENTS = {
  SendMessage: 'sendMessage',
  SendPacket: 'sendPacket',
  JoinRoom: 'joinRoom',
  LeaveRoom: 'leaveRoom',
  NewMessage: 'newMessage',
  NewPacket: 'newPacket',
  SenderKeysAvailable: 'senderKeysAvailable',
  UserOnline: 'userOnline',
  RoomDeleted: 'roomDeleted',
  UserLeftRoom: 'userLeftRoom',
  DeviceLinked: 'deviceLinked',
  DeviceRevoked: 'deviceRevoked',
  PeerDeviceLinked: 'peerDeviceLinked',
} as const;

/** Payload of the `deviceLinked` socket event. */
export interface DeviceLinkedEvent {
  deviceId: number;
  deviceName: string;
  linkedAt: string;
}

/**
 * Payload of the `deviceRevoked` socket event. The discriminator `self`
 * distinguishes:
 *   - `self: true`  → this socket's own device has been revoked. Force logout.
 *   - `self: false` → a peer revoked one of their devices. Drop the
 *     `(userId, revokedDeviceId)` session locally.
 */
export type DeviceRevokedEvent =
  | { self: true; revokedDeviceId: number; byUserId: string | number; revokedAt: string }
  | { self: false; userId: string | number; revokedDeviceId: number; revokedAt: string };

/**
 * Payload of the `peerDeviceLinked` socket event (frontend-0008 / backend-0009).
 *
 * Emitted by the backend to every peer of a user who just completed a
 * multi-device link. Receivers should invalidate their local `deviceMap`
 * cache for `userId` so the next outgoing message includes a ciphertext
 * for the newly-added device.
 *
 * Contract: `_shared/api/peer-device-linked.md`.
 */
export interface PeerDeviceLinkedEvent {
  userId: string | number;
  addedDeviceId: number;
  linkedAt: string;
}

/**
 * Per-device recipient for the multi-device fan-out wire shape.
 *
 * Each entry carries the libsignal ciphertext encrypted for one exact
 * `(userId, deviceId)` pair. The array travels **top-level** in the
 * `sendMessage` payload — the backend gateway only routes to its per-device
 * fan-out path (`fanOutToRecipients`) when `recipients` is top-level, never
 * when it is nested inside `message`. See
 * `_shared/specs/multidevice-send-wire-shape.md`.
 */
export interface RecipientFanout {
  userId: number;
  deviceId: number;
  ciphertext: string;
}

/**
 * Per-device recipient for the multi-device fan-out wire shape of control
 * packets (`sendPacket`). Each entry carries a full per-device envelope with
 * SOLO the ciphertext encrypted for one `(userId, deviceId)`. The array
 * travels **top-level** — the backend gateway only routes to
 * `fanOutPacketToRecipients` when `recipients` is top-level, never when
 * nested inside `packet`. See spec § "Control packets (`sendPacket`)".
 */
export interface PacketRecipientFanout {
  userId: number;
  deviceId: number;
  packet: MessageEnvelope | Record<string, unknown>;
}

/**
 * Envelope-level metadata that must survive the per-device fan-out.
 *
 * In the fan-out shape the per-device ciphertext replaces the whole
 * envelope, so the wire-relevant fields (`id_parent` for reply threading,
 * `version`) are carried out-of-band here; the backend re-applies them when
 * it rebuilds each recipient's envelope.
 */
export interface SendMessageMetadata {
  id_parent?: string;
  version?: string;
}

/** Acknowledgement returned by the server for a `sendMessage` emit. */
export interface SendMessageAck {
  success: boolean;
  delivered?: boolean;
  messageId?: string;
  id?: string;
  timestamp?: string;
  error?: string;
}

// Event handlers type
type MessageHandler = (envelope: MessageEnvelope) => void | Promise<void>;
type PacketHandler = (envelope: MessageEnvelope) => void | Promise<void>;
type StateChangeHandler = (state: SocketConnectionState) => void;

export class SocketService {
  private socket: Socket | null = null;
  private connectionState: SocketConnectionState = SocketConnectionState.CLOSED;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isDisconnecting = false;

  // Event handlers
  private messageHandlers: MessageHandler[] = [];
  private packetHandlers: PacketHandler[] = [];
  private stateChangeHandlers: StateChangeHandler[] = [];
  private senderKeysHandlers: ((data: any) => void)[] = [];
  private userOnlineHandlers: ((data: any) => void)[] = [];
  private authErrorHandlers: (() => void)[] = [];
  private roomDeletedHandlers: ((data: { roomId: number; deletedBy: number; timestamp: number }) => void)[] = [];
  private userLeftRoomHandlers: ((data: { roomId: number; userId: number; timestamp: number }) => void)[] = [];
  private deviceLinkedHandlers: ((data: DeviceLinkedEvent) => void)[] = [];
  private deviceRevokedHandlers: ((data: DeviceRevokedEvent) => void)[] = [];
  private peerDeviceLinkedHandlers: ((data: PeerDeviceLinkedEvent) => void)[] = [];

  /**
   * Token getter: injected by ServerRegistry to read the right per-server token.
   */
  private tokenGetter: (() => Promise<string | null>) | null = null;

  /**
   * Auth state checker: injected by ServerRegistry to check if the user is authenticated
   * without creating a circular dependency on auth.store.
   */
  private authChecker: (() => boolean) | null = null;

  public readonly useTor: boolean;

  constructor(
    public readonly serverId: number,
    private socketUrl: string,
    private namespace: string,
    useTor: boolean = false,
  ) {
    this.useTor = useTor;
  }

  /**
   * Set the token getter function (called by ServerRegistry).
   */
  setTokenGetter(getter: () => Promise<string | null>): void {
    this.tokenGetter = getter;
  }

  /**
   * Set the auth state checker (called by ServerRegistry).
   */
  setAuthChecker(checker: () => boolean): void {
    this.authChecker = checker;
  }

  // Getters
  getConnectionState(): SocketConnectionState {
    return this.connectionState;
  }

  isConnected(): boolean {
    return this.connectionState === SocketConnectionState.CONNECTED;
  }

  // Event subscriptions
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onPacket(handler: PacketHandler): () => void {
    this.packetHandlers.push(handler);
    return () => {
      this.packetHandlers = this.packetHandlers.filter((h) => h !== handler);
    };
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.push(handler);
    return () => {
      this.stateChangeHandlers = this.stateChangeHandlers.filter((h) => h !== handler);
    };
  }

  onSenderKeysAvailable(handler: (data: any) => void): () => void {
    this.senderKeysHandlers.push(handler);
    return () => {
      this.senderKeysHandlers = this.senderKeysHandlers.filter((h) => h !== handler);
    };
  }

  onUserOnline(handler: (data: any) => void): () => void {
    this.userOnlineHandlers.push(handler);
    return () => {
      this.userOnlineHandlers = this.userOnlineHandlers.filter((h) => h !== handler);
    };
  }

  onAuthError(handler: () => void): () => void {
    this.authErrorHandlers.push(handler);
    return () => {
      this.authErrorHandlers = this.authErrorHandlers.filter((h) => h !== handler);
    };
  }

  onRoomDeleted(handler: (data: { roomId: number; deletedBy: number; timestamp: number }) => void): () => void {
    this.roomDeletedHandlers.push(handler);
    return () => {
      this.roomDeletedHandlers = this.roomDeletedHandlers.filter((h) => h !== handler);
    };
  }

  onUserLeftRoom(handler: (data: { roomId: number; userId: number; timestamp: number }) => void): () => void {
    this.userLeftRoomHandlers.push(handler);
    return () => {
      this.userLeftRoomHandlers = this.userLeftRoomHandlers.filter((h) => h !== handler);
    };
  }

  onDeviceLinked(handler: (data: DeviceLinkedEvent) => void): () => void {
    this.deviceLinkedHandlers.push(handler);
    return () => {
      this.deviceLinkedHandlers = this.deviceLinkedHandlers.filter((h) => h !== handler);
    };
  }

  onDeviceRevoked(handler: (data: DeviceRevokedEvent) => void): () => void {
    this.deviceRevokedHandlers.push(handler);
    return () => {
      this.deviceRevokedHandlers = this.deviceRevokedHandlers.filter((h) => h !== handler);
    };
  }

  onPeerDeviceLinked(handler: (data: PeerDeviceLinkedEvent) => void): () => void {
    this.peerDeviceLinkedHandlers.push(handler);
    return () => {
      this.peerDeviceLinkedHandlers = this.peerDeviceLinkedHandlers.filter((h) => h !== handler);
    };
  }

  // Update connection state and notify handlers
  private updateState(state: SocketConnectionState) {
    this.connectionState = state;
    this.stateChangeHandlers.forEach((handler) => handler(state));
  }

  // Initialize connection
  async connect(): Promise<void> {
    if (useServerStore.getState().isBanned(this.serverId)) {
      logger.info(`[Socket:${this.serverId}] Server is banned — skipping connect`);
      return;
    }

    if (!this.tokenGetter) {
      logger.warn(`[Socket:${this.serverId}] No token getter configured`);
      return;
    }

    const token = await this.tokenGetter();
    if (!token) {
      const isAuthenticated = this.authChecker?.() ?? false;
      if (isAuthenticated) {
        logger.info(`[Socket:${this.serverId}] No token but authenticated — triggering logout`);
        this.authErrorHandlers.forEach((handler) => handler());
      } else {
        logger.info(`[Socket:${this.serverId}] No token — skipping connect`);
      }
      return;
    }

    if (this.connectionState !== SocketConnectionState.CLOSED) {
      logger.info(`[Socket:${this.serverId}] Already in state ${this.connectionState} — skipping connect`);
      return;
    }

    this.isDisconnecting = false;
    this.updateState(SocketConnectionState.CONNECTING);

    logger.info(`[Socket:${this.serverId}] Connecting to ${this.socketUrl}${this.namespace}`);

    const socketOpts: any = {
      autoConnect: false,
      transports: ['websocket'],
      auth: { token: `Bearer ${token}` },
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 60000,
      timeout: 20000,
    };

    // For .onion servers, pass TorWebSocket as custom WebSocket constructor.
    // engine.io-client patched to read opts.webSocket (see patches/engine.io-client.patch)
    if (this.useTor) {
      socketOpts.webSocket = TorWebSocket;
      // Hidden services need longer timeouts (circuit building + rendezvous)
      socketOpts.timeout = 120000;
      socketOpts.reconnectionDelay = 5000;
      socketOpts.reconnectionDelayMax = 120000;
    }

    this.socket = io(`${this.socketUrl}${this.namespace}`, socketOpts);

    this.attachListeners();
    this.socket.connect();
  }

  // Disconnect
  disconnect(): void {
    logger.info(`[Socket:${this.serverId}] disconnect() called`);
    this.isDisconnecting = true;
    this.detachListeners();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.updateState(SocketConnectionState.CLOSED);
  }

  /**
   * Remove all registered service-level handlers.
   */
  clearAllServiceHandlers(): void {
    this.messageHandlers = [];
    this.packetHandlers = [];
    this.stateChangeHandlers = [];
    this.senderKeysHandlers = [];
    this.userOnlineHandlers = [];
    this.authErrorHandlers = [];
    this.roomDeletedHandlers = [];
    this.userLeftRoomHandlers = [];
    this.deviceLinkedHandlers = [];
    this.deviceRevokedHandlers = [];
    this.peerDeviceLinkedHandlers = [];
  }

  // Attach socket listeners
  private attachListeners(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      logger.info(`[Socket:${this.serverId}] Connected OK`);
      this.reconnectAttempts = 0;
      this.updateState(SocketConnectionState.CONNECTED);
    });

    this.socket.on('disconnect', (reason) => {
      logger.info(`[Socket:${this.serverId}] Disconnected: ${reason}`);
      this.updateState(SocketConnectionState.CLOSED);
    });

    this.socket.on('connect_error', (error) => {
      logger.info(`[Socket:${this.serverId}] connect_error: ${error.message}`);

      if (error.message === 'BANNED') {
        logger.warn(`[Socket:${this.serverId}] Banned — updating store and disconnecting`);
        useServerStore.getState().setBanned(this.serverId, true);
        this.disconnect();
        return;
      }

      const isAuthError = error.message === 'Authentication failed' ||
        error.message?.toLowerCase().includes('auth') ||
        error.message?.includes('token');

      if (isAuthError) {
        logger.info(`[Socket:${this.serverId}] Auth error — triggering logout`);
        this.disconnect();
        this.authErrorHandlers.forEach((handler) => handler());
      }
    });

    this.socket.io.on('reconnect_attempt', (attempt) => {
      logger.info(`[Socket:${this.serverId}] Reconnect attempt ${attempt}`);
      this.reconnectAttempts = attempt;
      this.updateState(SocketConnectionState.CONNECTING);
    });

    this.socket.io.on('reconnect_failed', () => {
      logger.info(`[Socket:${this.serverId}] Reconnection failed (all attempts exhausted)`);
      this.disconnect();
    });

    // Message handlers — ack callback lets the server confirm actual delivery
    this.socket.on(CHAT_EVENTS.NewMessage, (data: any, ack?: (response: any) => void) => {
      logger.info(`[Socket:${this.serverId}] <- newMessage received, room:`, data?.message?.id_room ?? data?.roomId ?? data?.id_room);
      const envelope = this.extractEnvelope(data, 'message');
      if (envelope) {
        logger.info(`[Socket:${this.serverId}] <- newMessage envelope OK, category:`, envelope.category, 'room:', envelope.id_room, 'from:', envelope.id_user_from);
        // Ack immediately — confirms client received the data (before async decrypt/processing)
        if (ack) ack({ received: true });
        this.messageHandlers.forEach((handler) => handler(envelope));
      } else {
        logger.warn(`[Socket:${this.serverId}] <- newMessage: extractEnvelope returned null`, JSON.stringify(data).slice(0, 200));
        if (ack) ack({ received: false, error: 'invalid envelope' });
      }
    });

    this.socket.on(CHAT_EVENTS.NewPacket, (data: any, ack?: (response: any) => void) => {
      logger.info(`[Socket:${this.serverId}] <- newPacket received, room:`, data?.packet?.id_room ?? data?.id_room);
      const envelope = this.extractEnvelope(data, 'packet');
      if (envelope) {
        logger.info(`[Socket:${this.serverId}] <- newPacket envelope OK, category:`, envelope.category, 'from:', envelope.id_user_from);
        if (ack) ack({ received: true });
        this.packetHandlers.forEach((handler) => handler(envelope));
      } else {
        logger.warn(`[Socket:${this.serverId}] <- newPacket: extractEnvelope returned null`, JSON.stringify(data).slice(0, 200));
        if (ack) ack({ received: false, error: 'invalid envelope' });
      }
    });

    // Sender keys available notification
    this.socket.on(CHAT_EVENTS.SenderKeysAvailable, (data: any) => {
      this.senderKeysHandlers.forEach((handler) => handler(data));
    });

    // User online notification
    this.socket.on(CHAT_EVENTS.UserOnline, (data: any) => {
      this.userOnlineHandlers.forEach((handler) => handler(data));
    });

    // Room deleted notification
    this.socket.on(CHAT_EVENTS.RoomDeleted, (data: any) => {
      this.roomDeletedHandlers.forEach((handler) => handler(data));
    });

    // User left room notification
    this.socket.on(CHAT_EVENTS.UserLeftRoom, (data: any) => {
      this.userLeftRoomHandlers.forEach((handler) => handler(data));
    });

    // Multi-device pairing/revocation notifications
    this.socket.on(CHAT_EVENTS.DeviceLinked, (data: DeviceLinkedEvent) => {
      this.deviceLinkedHandlers.forEach((handler) => handler(data));
    });

    this.socket.on(CHAT_EVENTS.DeviceRevoked, (data: DeviceRevokedEvent) => {
      this.deviceRevokedHandlers.forEach((handler) => handler(data));
    });

    this.socket.on(CHAT_EVENTS.PeerDeviceLinked, (data: PeerDeviceLinkedEvent) => {
      this.peerDeviceLinkedHandlers.forEach((handler) => handler(data));
    });
  }

  // Detach socket listeners
  private detachListeners(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.io.removeAllListeners();
  }

  // Extract envelope from socket message
  private extractEnvelope(data: any, kind: 'message' | 'packet'): MessageEnvelope | null {
    const candidate = kind === 'message' ? data?.message : data?.packet;

    const normalized = this.normalizeEnvelopeCandidate(candidate, data);
    if (normalized) return normalized;

    if (candidate) {
      return this.normalizeFromSocketWrapper(data, candidate);
    }

    return this.normalizeEnvelopeCandidate(data) || this.normalizeFromSocketWrapper(data, data);
  }

  private isValidEnvelope(obj: any): boolean {
    return (
      typeof obj.category === 'string' &&
      typeof obj.id_room === 'number' &&
      typeof obj.id_user_from === 'number' &&
      typeof obj.id === 'string'
    );
  }

  private normalizeEnvelopeCandidate(candidate: any, wrapper?: any): MessageEnvelope | null {
    if (!candidate) return null;

    if (candidate.category && candidate.id_room) {
      if (!this.isValidEnvelope(candidate)) return null;
      this.liftWrapperFields(candidate, wrapper);
      return candidate as MessageEnvelope;
    }

    if (candidate.message?.category && candidate.message?.id_room) {
      if (!this.isValidEnvelope(candidate.message)) return null;
      this.liftWrapperFields(candidate.message, wrapper ?? candidate);
      return candidate.message as MessageEnvelope;
    }

    if (candidate.packet?.category && candidate.packet?.id_room) {
      if (!this.isValidEnvelope(candidate.packet)) return null;
      this.liftWrapperFields(candidate.packet, wrapper ?? candidate);
      return candidate.packet as MessageEnvelope;
    }

    return null;
  }

  // Lift wrapper-level camelCase fields onto an as-is envelope when the
  // envelope itself doesn't carry them. Today this is the asymmetric
  // wire shape from desktop/server: the wrapper has `senderDeviceId`
  // (camelCase) while the envelope is otherwise snake_case and may omit
  // `device_id_from`. Same idea for `idParent`. Without this lift, a
  // multi-device peer's control packet would decrypt against the wrong
  // session (deviceId=1 fallback) and fail silently.
  private liftWrapperFields(envelope: any, wrapper: any): void {
    if (!wrapper || wrapper === envelope) return;
    if (envelope.device_id_from == null && typeof wrapper.senderDeviceId === 'number') {
      envelope.device_id_from = wrapper.senderDeviceId;
    }
    if (envelope.id_parent == null) {
      const camel = wrapper.idParent;
      if (typeof camel === 'string' && camel.length > 0) {
        envelope.id_parent = camel;
      }
    }
  }

  private normalizeFromSocketWrapper(wrapper: any, payload: any): MessageEnvelope | null {
    if (!wrapper || wrapper.roomId === undefined || wrapper.senderId === undefined) {
      return null;
    }

    const timestamp = wrapper.timestamp ? new Date(wrapper.timestamp).getTime() : Date.now();

    return {
      id: payload?.id || wrapper.id || generateUUID(),
      timestamp,
      category: wrapper.category || payload?.category || 'senderkey_message',
      type: wrapper.type || payload?.type || 'text',
      payload: payload?.payload ?? payload ?? {},
      id_room: wrapper.roomId,
      id_user_from: wrapper.senderId,
      device_id_from: wrapper.senderDeviceId,
      id_user_to: payload?.id_user_to,
      encrypted: payload?.encrypted,
      id_parent: payload?.id_parent ?? payload?.idParent ?? wrapper?.idParent ?? null,
      version: payload?.version || wrapper.version || '2.0',
    } as MessageEnvelope;
  }

  // Emit with acknowledgement
  private emit<T>(event: string, payload: any, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        logger.warn(`[Socket:${this.serverId}] emit timeout for event:`, event);
        reject(new Error('Socket timeout'));
      }, timeoutMs);

      this.socket.emit(event, payload, (response: T) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  // Join a room
  async joinRoom(roomId: number): Promise<void> {
    if (!this.isConnected()) {
      logger.warn(`[Socket:${this.serverId}] Cannot join room - not connected`);
      return;
    }

    logger.info(`[Socket:${this.serverId}] Joining room:`, roomId);
    const response = await this.emit<{ success?: boolean; error?: string }>(
      CHAT_EVENTS.JoinRoom,
      { roomId }
    );

    if (response.error) {
      logger.error(`[Socket:${this.serverId}] Join room failed:`, response.error);
    } else {
      logger.info(`[Socket:${this.serverId}] Joined room:`, roomId, 'response:', JSON.stringify(response));
    }
  }

  // Leave a room
  async leaveRoom(roomId: number): Promise<void> {
    if (!this.isConnected()) return;

    await this.emit(CHAT_EVENTS.LeaveRoom, { roomId });
  }

  /**
   * Send a message. Two wire shapes, discriminated by the args object:
   *
   *  - **Fan-out** (`recipients[]`): per-device multi-device delivery. The
   *    backend routes to `fanOutToRecipients` ONLY when `recipients` is
   *    top-level. Used by the pair-wise / encrypted path.
   *  - **Legacy** (`message`): a single envelope with one ciphertext for the
   *    whole room. Used by the sender-key path.
   *
   * `recipients[]` must never be nested inside `message` — that drops the
   * send onto the legacy single-broadcast path, which filters by `userId`,
   * so the sender's own other devices never receive it. Contract:
   * `_shared/specs/multidevice-send-wire-shape.md`.
   */
  async sendMessage(args: {
    roomId: number;
    id?: string;
    recipients: RecipientFanout[];
    metadata?: SendMessageMetadata;
    category: string;
    type: string;
    volatile?: boolean;
  }): Promise<SendMessageAck>;
  async sendMessage(args: {
    roomId: number;
    message: MessageEnvelope | Record<string, unknown>;
    category: string;
    type: string;
    volatile?: boolean;
  }): Promise<SendMessageAck>;
  async sendMessage(args: {
    roomId: number;
    id?: string;
    recipients?: RecipientFanout[];
    message?: MessageEnvelope | Record<string, unknown>;
    metadata?: SendMessageMetadata;
    category: string;
    type: string;
    volatile?: boolean;
  }): Promise<SendMessageAck> {
    if (!this.isConnected()) {
      throw new Error('Socket not connected');
    }

    const payload: Record<string, unknown> = {
      roomId: args.roomId,
      category: args.category,
      type: args.type,
    };
    if (args.volatile) payload.volatile = true;

    if (args.recipients) {
      // Pass the client-generated envelope id through to the backend so the
      // base id used by `fanOutToRecipients` matches the id stored locally
      // by the sender — without this, delivery/read receipts (which carry
      // the backend-minted id) miss the local row. See
      // _shared/tasks/frontend-0017-clientmessageid-on-send.md. Requires
      // backend-0016 to honor the field; backend is back-compat (mints a
      // fresh id when `id` is absent).
      if (typeof args.id === 'string' && args.id.length > 0) payload.id = args.id;
      payload.recipients = args.recipients;
      if (args.metadata && (args.metadata.id_parent || args.metadata.version)) {
        payload.metadata = args.metadata;
      }
    } else {
      payload.message = args.message;
    }

    return this.emit<SendMessageAck>(CHAT_EVENTS.SendMessage, payload);
  }

  /**
   * Send a control packet. Two wire shapes, discriminated by the first arg:
   *
   *  - **Fan-out** (object arg `{ roomId, recipients[], volatile? }`):
   *    per-device multi-device delivery via `fanOutPacketToRecipients`.
   *    Each `recipients[]` entry carries a full per-device envelope.
   *  - **Legacy** (positional args `roomId, envelope, recipientIds?, …`):
   *    a single envelope broadcast to the room — falls onto
   *    `deliverPacketToRecipientIds` which filters by `userId` only and so
   *    drops the receipt on the sender's own other devices. Kept for the
   *    sender-key path (group-wide ciphertext, decryptable by every member).
   *
   * Contract: `_shared/specs/multidevice-send-wire-shape.md` § "Control
   * packets (`sendPacket`)".
   */
  async sendPacket(args: {
    roomId: number;
    recipients: PacketRecipientFanout[];
    volatile?: boolean;
  }): Promise<{ success: boolean; delivered?: boolean; packetId?: string; timestamp?: string; error?: string }>;
  async sendPacket(
    roomId: number,
    envelope: MessageEnvelope,
    recipientIds?: number[],
    volatile?: boolean
  ): Promise<{ success: boolean; error?: string }>;
  async sendPacket(
    roomIdOrArgs:
      | number
      | { roomId: number; recipients: PacketRecipientFanout[]; volatile?: boolean },
    envelope?: MessageEnvelope,
    recipientIds?: number[],
    volatile?: boolean,
  ): Promise<{ success: boolean; delivered?: boolean; packetId?: string; timestamp?: string; error?: string }> {
    if (!this.isConnected()) {
      throw new Error('Socket not connected');
    }

    if (typeof roomIdOrArgs === 'object' && Array.isArray(roomIdOrArgs.recipients)) {
      const args = roomIdOrArgs;
      logger.info(`[Socket:${this.serverId}] -> sendPacket fan-out room:`, args.roomId, 'recipients:', args.recipients.length, 'volatile:', !!args.volatile);
      const payload: Record<string, unknown> = {
        roomId: args.roomId,
        recipients: args.recipients,
      };
      if (args.volatile) payload.volatile = true;
      return this.emit(CHAT_EVENTS.SendPacket, payload);
    }

    const roomId = roomIdOrArgs as number;
    logger.info(`[Socket:${this.serverId}] -> sendPacket room:`, roomId, 'category:', envelope?.category, 'to:', recipientIds, 'volatile:', !!volatile);
    return this.emit(CHAT_EVENTS.SendPacket, {
      roomId,
      packet: envelope,
      recipientIds,
      ...(volatile ? { volatile: true } : {}),
    });
  }
}
