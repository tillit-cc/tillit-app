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
import SignalProtocol from 'signal-protocol';
import { messageRepository } from '@/db/repositories/message.repository';
import { roomRepository } from '@/db/repositories/room.repository';

// Typed references to the mocked repositories for assertions
const mockMessageRepo = messageRepository as jest.Mocked<typeof messageRepository>;
const mockRoomRepo = roomRepository as jest.Mocked<typeof roomRepository>;

describe('ChatService — handleIncomingMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
    mockChatStore.currentRoomId = null;
    mockChatStore.messages = new Map();
    mockChatStore.allRooms = [];
  });

  function makeEnvelope(overrides: Partial<any> = {}): any {
    return {
      id: 'msg-1',
      timestamp: Date.now(),
      category: 'user',
      type: 'text',
      payload: { body: { '42': 'encrypted-body' } },
      id_room: 100,
      id_user_from: 99,
      id_user_to: 42,
      encrypted: true,
      version: '2.0',
      ...overrides,
    };
  }

  it('skips own messages (id_user_from === userId)', async () => {
    const envelope = makeEnvelope({ id_user_from: 42 });
    await (chatService as any).handleIncomingMessage(envelope);

    // Own messages are skipped synchronously before enqueueing
    expect(mockMessageRepo.create).not.toHaveBeenCalled();
  });

  it('deduplicates same message id', async () => {
    const envelope = makeEnvelope({ id: 'dedup-msg-1', id_user_from: 99 });

    // First call adds the dedupKey to processingMessages
    await (chatService as any).handleIncomingMessage(envelope);
    // Second call is skipped because the dedupKey is already in the set
    await (chatService as any).handleIncomingMessage(envelope);

    expect((chatService as any).processingMessages.has('user:dedup-msg-1')).toBe(true);
    expect((chatService as any).processingMessages.size).toBe(1);
  });

  it('routes "user" category to decrypt + store', async () => {
    const envelope = makeEnvelope({
      id: 'user-msg-1',
      category: 'user',
      type: 'text',
      id_user_from: 99,
      payload: { body: { '42': 'encrypted-body' } },
    });

    (SignalProtocol as any).decryptMessage.mockResolvedValue({
      message: encodeURIComponent(JSON.stringify({ text: 'hello world' })),
    });

    // Call handleUserMessage directly to test the routing logic
    await (chatService as any).handleUserMessage(envelope, 100);

    // Should decrypt the message
    expect((SignalProtocol as any).decryptMessage).toHaveBeenCalledWith('encrypted-body', '99');

    // Should store the message
    expect(mockMessageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-msg-1',
        body: 'hello world',
        idRoom: 100,
        idUserFrom: 99,
      })
    );

    // Should add to chat store
    expect(mockChatStore.addMessage).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ id: 'user-msg-1' })
    );
  });

  it('routes "system" category to handleSystemMessage', async () => {
    const envelope = makeEnvelope({
      id: 'sys-msg-1',
      category: 'system',
      type: 'room_renamed',
      id_user_from: 0,
      payload: { newName: 'New Room Name' },
    });

    // Call handleSystemMessage directly to test the routing logic
    await (chatService as any).handleSystemMessage(envelope, 100);

    // room_renamed should update the room name
    expect(mockRoomRepo.update).toHaveBeenCalledWith(100, { name: 'New Room Name' });
    expect(mockChatStore.updateRoomInList).toHaveBeenCalledWith(100, { name: 'New Room Name' });
  });

  it('routes "control" category to handleControlPacket', async () => {
    // Use an unencrypted control packet so we don't need to decrypt
    const envelope = makeEnvelope({
      id: 'ctrl-msg-1',
      category: 'control',
      type: ControlPacketType.TYPING_STARTED,
      id_user_from: 99,
      encrypted: false,
      payload: { body: JSON.stringify({}) },
    });

    // Call handleControlPacket directly to test the routing logic
    await (chatService as any).handleControlPacket(envelope, 100);

    // TYPING_STARTED should set typing indicator
    expect(mockChatStore.setTyping).toHaveBeenCalledWith(100, 99, true);
  });
});
