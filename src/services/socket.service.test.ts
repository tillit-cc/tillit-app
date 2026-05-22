import { SocketConnectionState } from '@/types/connection';
import { MessageEnvelope } from '@/types/message';

// --- Mocks ---

const mockSocket = {
  on: jest.fn(),
  emit: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  connected: false,
  removeAllListeners: jest.fn(),
  io: { on: jest.fn(), removeAllListeners: jest.fn() },
};

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => mockSocket),
}));

jest.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: jest.fn(() => ({ isAuthenticated: true })) },
}), { virtual: true });

jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}), { virtual: true });

// --- Helpers ---

/**
 * Capture registered socket event callbacks by inspecting `mockSocket.on` calls.
 * Returns a map of event name -> callback for the underlying socket.
 */
function captureSocketListeners(): Record<string, (...args: any[]) => void> {
  const listeners: Record<string, (...args: any[]) => void> = {};
  for (const call of mockSocket.on.mock.calls) {
    listeners[call[0]] = call[1];
  }
  return listeners;
}

/**
 * Capture registered socket.io manager event callbacks (mockSocket.io.on).
 */
function captureManagerListeners(): Record<string, (...args: any[]) => void> {
  const listeners: Record<string, (...args: any[]) => void> = {};
  for (const call of mockSocket.io.on.mock.calls) {
    listeners[call[0]] = call[1];
  }
  return listeners;
}

// --- Import under test (after mocks) ---

import { SocketService, CHAT_EVENTS } from './socket.service';
import { useAuthStore } from '@/stores/auth.store';

// --- Suite ---

describe('SocketService', () => {
  let service: SocketService;

  const TOKEN = 'test-jwt-token';
  const tokenGetter = jest.fn<Promise<string | null>, []>(async () => TOKEN);

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mockSocket to defaults
    mockSocket.connected = false;
    mockSocket.on.mockClear();
    mockSocket.emit.mockClear();
    mockSocket.connect.mockClear();
    mockSocket.disconnect.mockClear();
    mockSocket.removeAllListeners.mockClear();
    mockSocket.io.on.mockClear();
    mockSocket.io.removeAllListeners.mockClear();

    // Fresh instance per test
    service = new SocketService(1, 'https://api.test.com', '/chat');
    service.setTokenGetter(tokenGetter);
    // The "no token but authenticated" branch is gated by an explicit
    // auth checker (no longer reads the store directly). Default to the
    // mocked store so individual tests can override via mockReturnValueOnce.
    service.setAuthChecker(() => useAuthStore.getState().isAuthenticated);
  });

  // ---------------------------------------------------------------
  // 1. Initial state is CLOSED
  // ---------------------------------------------------------------
  it('initial state is CLOSED', () => {
    expect(service.getConnectionState()).toBe(SocketConnectionState.CLOSED);
    expect(service.isConnected()).toBe(false);
  });

  // ---------------------------------------------------------------
  // 2. connect: transitions CONNECTING -> CONNECTED
  // ---------------------------------------------------------------
  it('connect transitions to CONNECTING then CONNECTED on socket connect event', async () => {
    const states: SocketConnectionState[] = [];
    service.onStateChange((s) => states.push(s));

    await service.connect();

    // After connect() returns, state should be CONNECTING
    expect(service.getConnectionState()).toBe(SocketConnectionState.CONNECTING);

    // Simulate the socket emitting 'connect'
    const listeners = captureSocketListeners();
    expect(listeners['connect']).toBeDefined();
    listeners['connect']();

    expect(service.getConnectionState()).toBe(SocketConnectionState.CONNECTED);
    expect(service.isConnected()).toBe(true);
    expect(states).toEqual([SocketConnectionState.CONNECTING, SocketConnectionState.CONNECTED]);
  });

  // ---------------------------------------------------------------
  // 3. connect: idempotent when already CONNECTING
  // ---------------------------------------------------------------
  it('connect is idempotent when already in CONNECTING state', async () => {
    await service.connect();
    expect(service.getConnectionState()).toBe(SocketConnectionState.CONNECTING);

    // Second call should be a no-op
    await service.connect();

    // io() should have been called only once
    const { io } = require('socket.io-client');
    expect(io).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // 4. connect: does nothing if no tokenGetter
  // ---------------------------------------------------------------
  it('connect does nothing if no tokenGetter is set', async () => {
    const noTokenService = new SocketService(2, 'https://api.test.com', '/chat');
    // Do NOT call setTokenGetter

    await noTokenService.connect();

    expect(noTokenService.getConnectionState()).toBe(SocketConnectionState.CLOSED);
    const { io } = require('socket.io-client');
    // io() should not have been called for this service (only from beforeEach if any)
    // Since we cleared mocks and this is a fresh call, check the latest call count
    expect(io).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // 5. connect: does nothing if tokenGetter returns null and not authenticated
  // ---------------------------------------------------------------
  it('connect does nothing if token is null and user is not authenticated', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValueOnce({ isAuthenticated: false });
    tokenGetter.mockResolvedValueOnce(null);

    await service.connect();

    expect(service.getConnectionState()).toBe(SocketConnectionState.CLOSED);
  });

  // ---------------------------------------------------------------
  // 6. connect: triggers authErrorHandlers if token null but isAuthenticated
  // ---------------------------------------------------------------
  it('connect triggers authErrorHandlers if token is null but user is authenticated', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValueOnce({ isAuthenticated: true });
    tokenGetter.mockResolvedValueOnce(null);

    const authErrorHandler = jest.fn();
    service.onAuthError(authErrorHandler);

    await service.connect();

    expect(authErrorHandler).toHaveBeenCalledTimes(1);
    expect(service.getConnectionState()).toBe(SocketConnectionState.CLOSED);
  });

  // ---------------------------------------------------------------
  // 7. disconnect: sets state to CLOSED, clears socket
  // ---------------------------------------------------------------
  it('disconnect sets state to CLOSED and clears the socket', async () => {
    await service.connect();
    expect(service.getConnectionState()).toBe(SocketConnectionState.CONNECTING);

    service.disconnect();

    expect(service.getConnectionState()).toBe(SocketConnectionState.CLOSED);
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(mockSocket.removeAllListeners).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // 8. disconnect: safe to call when already disconnected
  // ---------------------------------------------------------------
  it('disconnect is safe to call when already disconnected', () => {
    // No prior connect — socket is null internally
    expect(() => service.disconnect()).not.toThrow();
    expect(service.getConnectionState()).toBe(SocketConnectionState.CLOSED);
  });

  // ---------------------------------------------------------------
  // 9. onMessage: handler called on NewMessage event
  // ---------------------------------------------------------------
  it('onMessage registers handler that is called on NewMessage event', async () => {
    const handler = jest.fn();
    service.onMessage(handler);

    await service.connect();

    const listeners = captureSocketListeners();
    expect(listeners[CHAT_EVENTS.NewMessage]).toBeDefined();

    // Simulate incoming message with envelope in data.message
    const envelope: MessageEnvelope = {
      id: 'msg-1',
      timestamp: Date.now(),
      category: 'user',
      type: 'text',
      payload: { text: 'hello' },
      id_room: 10,
      id_user_from: 5,
    };

    const ack = jest.fn();
    listeners[CHAT_EVENTS.NewMessage]({ message: envelope }, ack);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(envelope);
    expect(ack).toHaveBeenCalledWith({ received: true });
  });

  // ---------------------------------------------------------------
  // 10. onMessage: unsubscribe removes handler
  // ---------------------------------------------------------------
  it('onMessage returns unsubscribe function that removes the handler', async () => {
    const handler = jest.fn();
    const unsub = service.onMessage(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    // Call once, should work
    const envelope: MessageEnvelope = {
      id: 'msg-2',
      timestamp: Date.now(),
      category: 'user',
      type: 'text',
      payload: { text: 'first' },
      id_room: 10,
      id_user_from: 5,
    };
    listeners[CHAT_EVENTS.NewMessage]({ message: envelope });
    expect(handler).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsub();

    // Should not be called again
    listeners[CHAT_EVENTS.NewMessage]({ message: envelope });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------
  // 11. onPacket: handler called on NewPacket event
  // ---------------------------------------------------------------
  it('onPacket registers handler that is called on NewPacket event', async () => {
    const handler = jest.fn();
    service.onPacket(handler);

    await service.connect();

    const listeners = captureSocketListeners();
    expect(listeners[CHAT_EVENTS.NewPacket]).toBeDefined();

    const envelope: MessageEnvelope = {
      id: 'pkt-1',
      timestamp: Date.now(),
      category: 'control',
      type: 'delivered',
      payload: {},
      id_room: 10,
      id_user_from: 3,
    };

    const ack = jest.fn();
    listeners[CHAT_EVENTS.NewPacket]({ packet: envelope }, ack);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(envelope);
    expect(ack).toHaveBeenCalledWith({ received: true });
  });

  // ---------------------------------------------------------------
  // 12. onStateChange: notified on state transitions
  // ---------------------------------------------------------------
  it('onStateChange handler is notified on every state transition', async () => {
    const stateHandler = jest.fn();
    service.onStateChange(stateHandler);

    await service.connect();
    // CONNECTING
    expect(stateHandler).toHaveBeenCalledWith(SocketConnectionState.CONNECTING);

    // Simulate connect
    const listeners = captureSocketListeners();
    listeners['connect']();
    expect(stateHandler).toHaveBeenCalledWith(SocketConnectionState.CONNECTED);

    // Disconnect
    service.disconnect();
    expect(stateHandler).toHaveBeenCalledWith(SocketConnectionState.CLOSED);

    expect(stateHandler).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------
  // 13. clearAllServiceHandlers: empties all handlers
  // ---------------------------------------------------------------
  it('clearAllServiceHandlers empties all registered handlers', async () => {
    const msgHandler = jest.fn();
    const pktHandler = jest.fn();
    const stateHandler = jest.fn();
    const skHandler = jest.fn();
    const onlineHandler = jest.fn();
    const authHandler = jest.fn();

    service.onMessage(msgHandler);
    service.onPacket(pktHandler);
    service.onStateChange(stateHandler);
    service.onSenderKeysAvailable(skHandler);
    service.onUserOnline(onlineHandler);
    service.onAuthError(authHandler);

    service.clearAllServiceHandlers();

    // After clearing, connect should NOT trigger stateHandler
    await service.connect();
    expect(stateHandler).not.toHaveBeenCalled();

    // Simulate events — none should fire
    const listeners = captureSocketListeners();
    const envelope: MessageEnvelope = {
      id: 'msg-3',
      timestamp: Date.now(),
      category: 'user',
      type: 'text',
      payload: {},
      id_room: 1,
      id_user_from: 1,
    };

    listeners[CHAT_EVENTS.NewMessage]({ message: envelope });
    expect(msgHandler).not.toHaveBeenCalled();

    listeners[CHAT_EVENTS.NewPacket]({ packet: envelope });
    expect(pktHandler).not.toHaveBeenCalled();

    listeners[CHAT_EVENTS.SenderKeysAvailable]({ roomId: 1 });
    expect(skHandler).not.toHaveBeenCalled();

    listeners[CHAT_EVENTS.UserOnline]({ userId: 1 });
    expect(onlineHandler).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // 14. extractEnvelope: normalizes candidate.category + id_room
  // ---------------------------------------------------------------
  it('extractEnvelope normalizes message with category + id_room on candidate', async () => {
    const handler = jest.fn();
    service.onMessage(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    const rawEnvelope = {
      id: 'env-1',
      timestamp: Date.now(),
      category: 'user' as const,
      type: 'text',
      payload: { text: 'hi' },
      id_room: 42,
      id_user_from: 7,
    };

    // data.message has category + id_room directly
    listeners[CHAT_EVENTS.NewMessage]({ message: rawEnvelope });

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0][0] as MessageEnvelope;
    expect(received.category).toBe('user');
    expect(received.id_room).toBe(42);
    expect(received.id_user_from).toBe(7);
  });

  // ---------------------------------------------------------------
  // 15. extractEnvelope: normalizes socket wrapper format (roomId + senderId)
  // ---------------------------------------------------------------
  it('extractEnvelope normalizes socket wrapper format with roomId + senderId', async () => {
    const handler = jest.fn();
    service.onMessage(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    // Socket wrapper format: top-level roomId/senderId, no category/id_room on candidate
    const data = {
      roomId: 99,
      senderId: 15,
      category: 'senderkey_message',
      type: 'text',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        id: 'wrap-1',
        payload: { text: 'wrapped' },
        encrypted: true,
      },
    };

    listeners[CHAT_EVENTS.NewMessage](data);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0][0] as MessageEnvelope;
    expect(received.id_room).toBe(99);
    expect(received.id_user_from).toBe(15);
    expect(received.category).toBe('senderkey_message');
    expect(received.encrypted).toBe(true);
  });

  // ---------------------------------------------------------------
  // 16. sendMessage: throws when not connected
  // ---------------------------------------------------------------
  it('sendMessage throws when socket is not connected', async () => {
    const envelope = {
      id: 'msg-fail',
      timestamp: Date.now(),
      category: 'user' as const,
      type: 'text',
      payload: { text: 'fail' },
      id_room: 1,
      id_user_from: 1,
    };

    await expect(
      service.sendMessage({ roomId: 1, message: envelope, category: 'user', type: 'text' }),
    ).rejects.toThrow('Socket not connected');
  });

  // ---------------------------------------------------------------
  // 17. sendPacket: throws when not connected
  // ---------------------------------------------------------------
  it('sendPacket throws when socket is not connected', async () => {
    const envelope = {
      id: 'pkt-fail',
      timestamp: Date.now(),
      category: 'control' as const,
      type: 'delivered',
      payload: {},
      id_room: 1,
      id_user_from: 1,
    };

    await expect(
      service.sendPacket(1, envelope),
    ).rejects.toThrow('Socket not connected');
  });

  // ---------------------------------------------------------------
  // 18. emit with ack: resolves on callback
  // ---------------------------------------------------------------
  it('emit resolves with ack response when socket is connected', async () => {
    await service.connect();

    // Simulate connected state
    const listeners = captureSocketListeners();
    listeners['connect']();
    mockSocket.connected = true;

    // Mock emit to invoke the ack callback
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true, delivered: true });
      },
    );

    const envelope: MessageEnvelope = {
      id: 'msg-ack',
      timestamp: Date.now(),
      category: 'user',
      type: 'text',
      payload: { text: 'ack test' },
      id_room: 5,
      id_user_from: 2,
    };

    const result = await service.sendMessage({ roomId: 5, message: envelope, category: 'user', type: 'text' });

    expect(result).toEqual({ success: true, delivered: true });
    expect(mockSocket.emit).toHaveBeenCalledWith(
      CHAT_EVENTS.SendMessage,
      expect.objectContaining({ roomId: 5, message: envelope, category: 'user', type: 'text' }),
      expect.any(Function),
    );
  });

  // ---------------------------------------------------------------
  // 19. sendMessage fan-out: recipients[] travel top-level, not in message
  // ---------------------------------------------------------------
  it('sendMessage with recipients[] emits them top-level (never nested in message)', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true, delivered: true, messageId: 'srv-1' });
      },
    );

    const recipients = [
      { userId: 1059, deviceId: 1, ciphertext: 'ct-android' },
      { userId: 1067, deviceId: 1, ciphertext: 'ct-self-primary' },
    ];

    const result = await service.sendMessage({
      roomId: 163,
      recipients,
      category: 'user',
      type: 'text',
    });

    expect(result).toEqual({ success: true, delivered: true, messageId: 'srv-1' });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.roomId).toBe(163);
    expect(emitted.category).toBe('user');
    expect(emitted.recipients).toEqual(recipients);
    // The fan-out recipients MUST be top-level — the backend gateway only
    // routes to fanOutToRecipients when `recipients` is top-level.
    expect(emitted.message).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // 20. sendMessage fan-out: metadata + volatile carried top-level
  // ---------------------------------------------------------------
  it('sendMessage with recipients[] carries metadata and volatile top-level', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    await service.sendMessage({
      roomId: 7,
      recipients: [{ userId: 2, deviceId: 1, ciphertext: 'ct' }],
      metadata: { id_parent: 'parent-msg', version: '2.0' },
      category: 'user',
      type: 'text',
      volatile: true,
    });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.metadata).toEqual({ id_parent: 'parent-msg', version: '2.0' });
    expect(emitted.volatile).toBe(true);
  });

  // ---------------------------------------------------------------
  // 21. sendMessage fan-out: empty metadata omitted from the wire
  // ---------------------------------------------------------------
  it('sendMessage with recipients[] omits metadata when it has no fields', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    await service.sendMessage({
      roomId: 7,
      recipients: [{ userId: 2, deviceId: 1, ciphertext: 'ct' }],
      metadata: {},
      category: 'user',
      type: 'text',
    });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.metadata).toBeUndefined();
    expect('volatile' in emitted).toBe(false);
  });

  // ---------------------------------------------------------------
  // 22. sendMessage legacy: message envelope, no recipients
  // ---------------------------------------------------------------
  it('sendMessage legacy path emits a message envelope and no recipients', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    const envelope = {
      id: 'sk-1',
      timestamp: Date.now(),
      category: 'senderkey_message',
      type: 'text',
      payload: { ciphertext: 'sk-ct', distributionId: 'd1' },
      id_room: 9,
      id_user_from: 3,
    };

    await service.sendMessage({
      roomId: 9,
      message: envelope,
      category: 'senderkey_message',
      type: 'text',
    });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.message).toEqual(envelope);
    expect(emitted.recipients).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // 23. sendMessage fan-out: client envelope id forwarded as top-level `id`
  //     (frontend-0017 — aligns backend baseId with the local envelopeId)
  // ---------------------------------------------------------------
  it('sendMessage with recipients[] forwards `id` top-level when provided', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    await service.sendMessage({
      roomId: 7,
      id: 'env-abc-123',
      recipients: [{ userId: 2, deviceId: 1, ciphertext: 'ct' }],
      category: 'user',
      type: 'text',
    });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.id).toBe('env-abc-123');
    expect(emitted.recipients).toBeDefined();
  });

  // ---------------------------------------------------------------
  // 24. extractEnvelope lifts senderDeviceId from wrapper onto an as-is
  //     candidate envelope (frontend-0018 — newPacket multi-device peer).
  // ---------------------------------------------------------------
  it('extractEnvelope lifts senderDeviceId from wrapper into envelope.device_id_from', async () => {
    const handler = jest.fn();
    service.onPacket(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    // Desktop-style control packet: candidate has full snake_case envelope but
    // no device_id_from; senderDeviceId is on the outer wrapper.
    const candidate = {
      id: 'ctrl-1',
      timestamp: Date.now(),
      category: 'control' as const,
      type: 'READ',
      payload: { id_message: 'm1' },
      id_room: 42,
      id_user_from: 1067,
    };
    const data = {
      senderDeviceId: 4,
      packet: candidate,
    };

    listeners[CHAT_EVENTS.NewPacket](data);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0][0] as MessageEnvelope;
    expect(received.device_id_from).toBe(4);
    expect(received.id_user_from).toBe(1067);
  });

  // ---------------------------------------------------------------
  // 25. extractEnvelope lifts idParent (camelCase) from wrapper onto an
  //     as-is candidate envelope (frontend-0014 — reply threading after
  //     server-side fan-out envelope reconstruction).
  // ---------------------------------------------------------------
  it('extractEnvelope lifts idParent (camelCase) into envelope.id_parent', async () => {
    const handler = jest.fn();
    service.onMessage(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    const candidate = {
      id: 'msg-2',
      timestamp: Date.now(),
      category: 'user' as const,
      type: 'text',
      payload: { encrypted: 'ct' },
      id_room: 42,
      id_user_from: 7,
    };
    // Backend wraps the fan-out envelope with camelCase wrapper-level fields.
    const data = {
      idParent: 'parent-msg-1',
      message: candidate,
    };

    listeners[CHAT_EVENTS.NewMessage](data);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0][0] as MessageEnvelope;
    expect(received.id_parent).toBe('parent-msg-1');
  });

  // ---------------------------------------------------------------
  // 27. sendPacket fan-out: recipients[] travel top-level (never nested in
  //     packet). The backend gateway only routes to fanOutPacketToRecipients
  //     when `recipients` is top-level — nesting drops the receipt onto the
  //     legacy single-broadcast path (frontend-0019).
  // ---------------------------------------------------------------
  it('sendPacket with recipients[] emits them top-level (never nested in packet)', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true, delivered: true, packetId: 'srv-pkt-1', timestamp: 't' });
      },
    );

    const recipients = [
      {
        userId: 1067,
        deviceId: 1,
        packet: {
          id: 'pkt-1',
          timestamp: 1,
          category: 'control',
          type: 'read',
          payload: { ciphertext: 'ct-primary' },
          id_room: 163,
          id_user_from: 1059,
          id_user_to: 1067,
          encrypted: true,
          version: '2.0',
        },
      },
      {
        userId: 1067,
        deviceId: 4,
        packet: {
          id: 'pkt-1',
          timestamp: 1,
          category: 'control',
          type: 'read',
          payload: { ciphertext: 'ct-desktop' },
          id_room: 163,
          id_user_from: 1059,
          id_user_to: 1067,
          encrypted: true,
          version: '2.0',
        },
      },
    ];

    const result = await service.sendPacket({ roomId: 163, recipients });

    expect(result).toEqual({ success: true, delivered: true, packetId: 'srv-pkt-1', timestamp: 't' });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.roomId).toBe(163);
    expect(emitted.recipients).toEqual(recipients);
    // The fan-out recipients MUST be top-level. The backend gateway only
    // routes to fanOutPacketToRecipients when `recipients` is top-level;
    // a nested `packet.payload.recipients` falls onto the legacy broadcast
    // path that filters by userId only.
    expect(emitted.packet).toBeUndefined();
    expect(emitted.recipientIds).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // 28. sendPacket fan-out: volatile carried top-level (typing).
  // ---------------------------------------------------------------
  it('sendPacket with recipients[] carries volatile top-level', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    await service.sendPacket({
      roomId: 7,
      recipients: [
        {
          userId: 2,
          deviceId: 1,
          packet: {
            id: 'pkt-typ',
            timestamp: 1,
            category: 'control',
            type: 'typing_started',
            payload: { ciphertext: 'ct' },
            id_room: 7,
            id_user_from: 1,
            encrypted: true,
            version: '2.0',
          },
        },
      ],
      volatile: true,
    });

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.volatile).toBe(true);
  });

  // ---------------------------------------------------------------
  // 29. sendPacket legacy: positional args → single envelope wire shape.
  //     Kept for the sender-key control-packet path (group-wide ciphertext).
  // ---------------------------------------------------------------
  it('sendPacket legacy positional path emits packet + recipientIds (no top-level recipients)', async () => {
    await service.connect();
    captureSocketListeners()['connect']();
    mockSocket.connected = true;
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: any, ackCb: (response: any) => void) => {
        ackCb({ success: true });
      },
    );

    const envelope: MessageEnvelope = {
      id: 'sk-pkt-1',
      timestamp: Date.now(),
      category: 'control',
      type: 'read',
      payload: { ciphertext: 'sk-ct', distributionId: 'd1' },
      id_room: 9,
      id_user_from: 3,
    };

    await service.sendPacket(9, envelope, [4], true);

    const emitted = mockSocket.emit.mock.calls[0][1];
    expect(emitted.roomId).toBe(9);
    expect(emitted.packet).toEqual(envelope);
    expect(emitted.recipientIds).toEqual([4]);
    expect(emitted.volatile).toBe(true);
    expect(emitted.recipients).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // 30. extractEnvelope wrapper path reads idParent (camelCase) from
  //     wrapper when the inner payload doesn't carry it (frontend-0014).
  // ---------------------------------------------------------------
  it('extractEnvelope wrapper path reads idParent (camelCase) from wrapper', async () => {
    const handler = jest.fn();
    service.onMessage(handler);

    await service.connect();
    const listeners = captureSocketListeners();

    // Backend fan-out wire: envelope is the top-level data with camelCase
    // `idParent`/`roomId`/`senderId`/`senderDeviceId`. The inner `message`
    // is the ciphertext, not an envelope.
    const data = {
      id: 'msg-3',
      roomId: 99,
      senderId: 15,
      senderDeviceId: 2,
      category: 'user',
      type: 'text',
      idParent: 'parent-msg-2',
      timestamp: '2024-01-01T00:00:00Z',
      message: { encrypted: 'ct' },
    };

    listeners[CHAT_EVENTS.NewMessage](data);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0][0] as MessageEnvelope;
    expect(received.id_parent).toBe('parent-msg-2');
    expect(received.device_id_from).toBe(2);
  });
});
