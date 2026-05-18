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
      service.sendMessage(1, envelope, 'user', 'text'),
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

    const result = await service.sendMessage(5, envelope, 'user', 'text');

    expect(result).toEqual({ success: true, delivered: true });
    expect(mockSocket.emit).toHaveBeenCalledWith(
      CHAT_EVENTS.SendMessage,
      expect.objectContaining({ roomId: 5, message: envelope, category: 'user', type: 'text' }),
      expect.any(Function),
    );
  });
});
