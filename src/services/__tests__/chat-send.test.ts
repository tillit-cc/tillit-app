import { MessageStatus, ControlPacketType, UserMessageType } from '@/types/message';

// SignalProtocol is mocked globally via moduleNameMapper -> __mocks__/signal-protocol.ts

// Mock expo-haptics
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

// Mocks for repositories — defined inline inside jest.mock factories to avoid hoisting issues.
jest.mock('@/db/repositories/message.repository', () => ({
  messageRepository: {
    create: jest.fn(),
    findById: jest.fn().mockResolvedValue(null),
    findByRoom: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn(),
    updateBody: jest.fn(),
    findStuckSending: jest.fn().mockResolvedValue([]),
    replaceId: jest.fn(),
    delete: jest.fn(),
    markAsRead: jest.fn(),
    findByRoomAndType: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('@/db/repositories/room.repository', () => ({
  roomRepository: {
    findById: jest.fn().mockResolvedValue(null),
    upsert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    hardDelete: jest.fn(),
    findAllWithMetadata: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('@/db/repositories/session.repository', () => ({
  sessionRepository: {
    findByRoom: jest.fn().mockResolvedValue([]),
    findByUserAndRoom: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@/db/repositories/profile.repository', () => ({
  profileRepository: {
    upsert: jest.fn(),
    findByRoom: jest.fn().mockResolvedValue([]),
  },
}));

// Mock services
const mockSocket = { onMessage: jest.fn(() => jest.fn()), onPacket: jest.fn(() => jest.fn()), onStateChange: jest.fn(() => jest.fn()), onSenderKeysAvailable: jest.fn(() => jest.fn()), sendMessage: jest.fn().mockResolvedValue({ success: true }), sendPacket: jest.fn().mockResolvedValue({ success: true }), isConnected: jest.fn(() => true), clearAllServiceHandlers: jest.fn(), joinRoom: jest.fn() };
const mockApi = { getAllRooms: jest.fn().mockResolvedValue({ rooms: [] }), getRoomMembers: jest.fn().mockResolvedValue([]), createRoom: jest.fn(), joinRoom: jest.fn(), deleteRoom: jest.fn(), deleteMessage: jest.fn(), deleteMedia: jest.fn() };

jest.mock('../server-registry', () => ({
  serverRegistry: {
    getAllServers: jest.fn(() => [{ id: 1 }]),
    getSocket: jest.fn(() => mockSocket),
    getSocketForRoom: jest.fn(() => mockSocket),
    getApi: jest.fn(() => mockApi),
    getApiForRoom: jest.fn(() => mockApi),
    getUserIdForRoom: jest.fn(() => 42),
    getUserIdForServer: jest.fn(() => 42),
    getDefaultServerId: jest.fn(() => 1),
  },
}));

jest.mock('../session.service', () => ({
  sessionService: {
    setSession: jest.fn().mockResolvedValue(true),
    ensureSession: jest.fn().mockResolvedValue(true),
    ensureSessionInDatabase: jest.fn().mockResolvedValue(undefined),
    updateSessionTimestamp: jest.fn().mockResolvedValue(undefined),
    recoverSession: jest.fn().mockResolvedValue(undefined),
    refreshPreKeysIfNeeded: jest.fn().mockResolvedValue(undefined),
    handleIdentityKeyChanged: jest.fn(),
    deleteSessionsByRoom: jest.fn().mockResolvedValue(undefined),
    loadSessions: jest.fn().mockResolvedValue([]),
    initializePreKeyTracking: jest.fn().mockResolvedValue(undefined),
    getRemoteDeviceIds: jest.fn(() => [] as number[]),
    fetchAllRemoteBundles: jest.fn().mockResolvedValue([]),
    ensureSessionForOwnLinkedDevice: jest.fn().mockResolvedValue(true),
    ensureSessionForRemotePeerDevice: jest.fn().mockResolvedValue(true),
    refreshRemoteDeviceMap: jest.fn().mockResolvedValue([] as number[]),
    invalidateRemoteDeviceMap: jest.fn(),
  },
}));

jest.mock('../sender-key.service', () => ({
  senderKeyService: {
    encryptWithSenderKey: jest.fn().mockResolvedValue({ ciphertext: 'sk-enc', distributionId: 'dist-1' }),
    decryptWithSenderKey: jest.fn().mockResolvedValue(JSON.stringify({ text: 'hello' })),
    fetchAndProcessPendingSenderKeys: jest.fn().mockResolvedValue(undefined),
    initializeSenderKeysIfNeeded: jest.fn().mockResolvedValue(undefined),
    redistributeToNewMembers: jest.fn().mockResolvedValue(undefined),
    handleMemberLeft: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../queue.service', () => ({
  queueService: {
    setSendFunction: jest.fn(),
    startProcessor: jest.fn(),
    stopProcessor: jest.fn(),
    clearQueue: jest.fn(),
    forceProcess: jest.fn().mockResolvedValue(undefined),
    addMessage: jest.fn(),
  },
}));

jest.mock('../media-crypto.service', () => ({
  mediaCryptoService: { encrypt: jest.fn(), decrypt: jest.fn() },
}));

const mockChatStore = { currentRoomId: null as number | null, messages: new Map(), allRooms: [] as any[], addMessage: jest.fn(), updateMessage: jest.fn(), removeMessage: jest.fn(), setMessages: jest.fn(), prependMessages: jest.fn(), replaceMessageId: jest.fn(), addRoomToList: jest.fn(), updateRoomInList: jest.fn(), removeRoomFromList: jest.fn(), clearRoom: jest.fn(), clearAll: jest.fn(), setAllRooms: jest.fn(), setProfiles: jest.fn(), updateProfile: jest.fn(), setTyping: jest.fn(), setPaginationState: jest.fn() };
jest.mock('@/stores/chat.store', () => ({ useChatStore: { getState: jest.fn(() => mockChatStore) } }));
jest.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: jest.fn(() => ({ isAuthenticated: true, userId: 42 })) } }));
jest.mock('@/stores/server.store', () => ({ useServerStore: { getState: jest.fn(() => ({ setConnectionState: jest.fn() })) } }));
jest.mock('@/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/utils/image', () => ({ generateThumbnailFromBase64: jest.fn(), saveImageToFile: jest.fn().mockResolvedValue('/path/to/image.jpg'), deleteImagesByMessageIds: jest.fn(), readImageAsBase64: jest.fn() }));

import { chatService } from '../chat.service';
import { useAuthStore } from '@/stores/auth.store';
import { queueService } from '../queue.service';
import SignalProtocol from 'signal-protocol';
import { messageRepository } from '@/db/repositories/message.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { sessionRepository } from '@/db/repositories/session.repository';
import { sessionService } from '../session.service';

// Typed references to the mocked repositories for assertions
const mockMessageRepo = messageRepository as jest.Mocked<typeof messageRepository>;
const mockRoomRepo = roomRepository as jest.Mocked<typeof roomRepository>;
const mockSessionRepo = sessionRepository as jest.Mocked<typeof sessionRepository>;

describe('ChatService — sendMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
    mockChatStore.currentRoomId = null;
    mockChatStore.messages = new Map();
    mockChatStore.allRooms = [];

    // Default: room exists (pair-wise, no sender keys), one remote session
    mockRoomRepo.findById.mockResolvedValue({ id: 100, useSenderKeys: 0 } as any);
    mockSessionRepo.findByRoom.mockResolvedValue([
      { idUser: 99, idRoom: 100 },
    ] as any);
  });

  it('creates envelope, encrypts, sends via socket, stores optimistic message', async () => {
    mockSocket.sendMessage.mockResolvedValue({ success: true });

    await chatService.sendMessage(100, 'Hello world');

    // Should create an optimistic message in DB and store
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Hello world',
        idRoom: 100,
        idUserFrom: 42,
        idStatus: MessageStatus.SENDING,
        type: UserMessageType.TEXT,
      })
    );
    expect(mockChatStore.addMessage).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        body: 'Hello world',
        idStatus: MessageStatus.SENDING,
      })
    );

    // Should encrypt the message for the remote user
    expect((SignalProtocol as any).encryptMessage).toHaveBeenCalled();

    // Should send via socket
    expect(mockSocket.sendMessage).toHaveBeenCalled();
  });

  it('throws if not authenticated', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValueOnce({
      isAuthenticated: false,
      userId: null,
    });

    await expect(chatService.sendMessage(100, 'Hello')).rejects.toThrow('Not authenticated');
  });

  it('queues when socket not connected', async () => {
    mockSocket.sendMessage.mockRejectedValue(new Error('not connected'));

    await chatService.sendMessage(100, 'Hello offline');

    // Should queue the message
    expect(queueService.addMessage).toHaveBeenCalled();
  });

  it('marks FAILED on non-timeout error', async () => {
    mockSocket.sendMessage.mockRejectedValue(new Error('some random error'));

    await chatService.sendMessage(100, 'Hello fail');

    // Should mark the message as FAILED
    expect(mockMessageRepo.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      MessageStatus.FAILED
    );
    expect(mockChatStore.updateMessage).toHaveBeenCalledWith(
      100,
      expect.any(String),
      expect.objectContaining({ idStatus: MessageStatus.FAILED })
    );
  });

  it('marks SENT on success', async () => {
    mockSocket.sendMessage.mockResolvedValue({ success: true });

    await chatService.sendMessage(100, 'Hello success');

    // Should mark the message as SENT
    expect(mockMessageRepo.updateStatus).toHaveBeenCalledWith(
      expect.any(String),
      MessageStatus.SENT
    );
    expect(mockChatStore.updateMessage).toHaveBeenCalledWith(
      100,
      expect.any(String),
      expect.objectContaining({ idStatus: MessageStatus.SENT })
    );
  });

  describe('fan-out wire shape', () => {
    afterEach(() => {
      // Restore the module-level default so deviceMap-dependent tests
      // outside this block don't inherit a stale per-user mapping.
      (sessionService.getRemoteDeviceIds as jest.Mock).mockImplementation(() => []);
    });

    it('emits recipients[] with userId as number (not string) for peer entries', async () => {
      mockSocket.sendMessage.mockResolvedValue({ success: true });

      await chatService.sendMessage(100, 'Hello peer');

      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          recipients: expect.arrayContaining([
            expect.objectContaining({
              userId: 99,
              deviceId: 1,
              ciphertext: expect.any(String),
            }),
          ]),
        })
      );
      const call = mockSocket.sendMessage.mock.calls.at(-1)![0];
      for (const recipient of call.recipients) {
        expect(typeof recipient.userId).toBe('number');
      }
    });

    it('includes self-fanout entries for ownUserId linked devices with userId as number', async () => {
      // Two peer sessions (peer 99) and self-cache reports a linked device 4
      // for ownUserId 42. The encrypt() loop must produce a recipient for
      // (42, 4) — not (42, 1), which is the primary and the sender itself.
      (sessionService.getRemoteDeviceIds as jest.Mock).mockImplementation((uid: string) => {
        if (uid === '42') return [1, 4];
        if (uid === '99') return [1];
        return [];
      });
      mockSocket.sendMessage.mockResolvedValue({ success: true });

      await chatService.sendMessage(100, 'Hello multi-device');

      const call = mockSocket.sendMessage.mock.calls.at(-1)![0];
      const selfFanout = call.recipients.find(
        (r: any) => r.userId === 42 && r.deviceId === 4
      );
      expect(selfFanout).toBeDefined();
      expect(typeof selfFanout.userId).toBe('number');
      // Sender's own primary device must NOT be in recipients — that's an echo.
      const selfPrimary = call.recipients.find(
        (r: any) => r.userId === 42 && r.deviceId === 1
      );
      expect(selfPrimary).toBeUndefined();
    });
  });
});
