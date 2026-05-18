import { MessageStatus, ControlPacketType, UserMessageType } from '@/types/message';

// Mock SignalProtocol
jest.mock('signal-protocol', () => ({
  default: {
    encryptMessage: jest.fn().mockResolvedValue({ encryptedMessage: 'encrypted' }),
    decryptMessage: jest.fn().mockResolvedValue({ message: encodeURIComponent(JSON.stringify({ text: 'hello' })) }),
    encryptGroupMessage: jest.fn().mockResolvedValue({ ciphertext: 'group-enc' }),
    decryptGroupMessage: jest.fn().mockResolvedValue({ message: JSON.stringify({ text: 'hello' }) }),
  },
}));

// Mock expo-haptics
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

// Mocks for repositories — defined inline inside jest.mock factories to avoid hoisting issues.
// The mock objects are retrieved after import via jest.requireMock().
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
import { senderKeyService } from '../sender-key.service';
import { messageRepository } from '@/db/repositories/message.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { profileRepository } from '@/db/repositories/profile.repository';

// Typed references to the mocked repositories for assertions
const mockMessageRepo = messageRepository as jest.Mocked<typeof messageRepository>;
const mockRoomRepo = roomRepository as jest.Mocked<typeof roomRepository>;
const mockProfileRepo = profileRepository as jest.Mocked<typeof profileRepository>;

describe('ChatService — processControlPacket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
    mockChatStore.currentRoomId = null;
    mockChatStore.messages = new Map();
    mockChatStore.allRooms = [];
  });

  it('MESSAGE_DELIVERED: updates message status if current < DELIVERED', async () => {
    // Set up a message in the store with status SENT (2)
    const roomMessages = [
      { id: 'msg-1', idStatus: MessageStatus.SENT },
    ];
    mockChatStore.messages.set(100, roomMessages);

    await (chatService as any).processControlPacket(
      ControlPacketType.MESSAGE_DELIVERED,
      { id_message: 'msg-1' },
      100,
      99
    );

    // Should update status to DELIVERED
    expect(mockMessageRepo.updateStatus).toHaveBeenCalledWith('msg-1', MessageStatus.DELIVERED);
    expect(mockChatStore.updateMessage).toHaveBeenCalledWith(
      100,
      'msg-1',
      { idStatus: MessageStatus.DELIVERED }
    );
  });

  it('MESSAGE_DELIVERED: skips if already at DELIVERED or higher', async () => {
    // Message is already at READ (4) status
    const roomMessages = [
      { id: 'msg-1', idStatus: MessageStatus.READ },
    ];
    mockChatStore.messages.set(100, roomMessages);

    await (chatService as any).processControlPacket(
      ControlPacketType.MESSAGE_DELIVERED,
      { id_message: 'msg-1' },
      100,
      99
    );

    // Should NOT update — already at a higher status
    expect(mockMessageRepo.updateStatus).not.toHaveBeenCalled();
    expect(mockChatStore.updateMessage).not.toHaveBeenCalled();
  });

  it('MESSAGE_READ: updates message status if current < READ', async () => {
    // Message at DELIVERED (3) — should upgrade to READ (4)
    const roomMessages = [
      { id: 'msg-1', idStatus: MessageStatus.DELIVERED },
    ];
    mockChatStore.messages.set(100, roomMessages);

    await (chatService as any).processControlPacket(
      ControlPacketType.MESSAGE_READ,
      { id_message: 'msg-1' },
      100,
      99
    );

    expect(mockMessageRepo.updateStatus).toHaveBeenCalledWith('msg-1', MessageStatus.READ);
    expect(mockChatStore.updateMessage).toHaveBeenCalledWith(
      100,
      'msg-1',
      { idStatus: MessageStatus.READ }
    );
  });

  it('SESSION_ESTABLISHED: updates room hasSession, redistributes sender keys', async () => {
    // Room uses sender keys
    mockRoomRepo.findById.mockResolvedValue({ id: 100, useSenderKeys: 1 } as any);

    await (chatService as any).processControlPacket(
      ControlPacketType.SESSION_ESTABLISHED,
      { timestamp: Date.now() },
      100,
      77
    );

    // Should mark hasSession true on the room
    expect(mockChatStore.updateRoomInList).toHaveBeenCalledWith(100, { hasSession: true });

    // Should upsert profile for the sender
    expect(mockProfileRepo.upsert).toHaveBeenCalledWith({
      idUser: 77,
      idRoom: 100,
      username: 'user-77',
    });

    // Since room uses sender keys, should redistribute to the new member
    expect(senderKeyService.redistributeToNewMembers).toHaveBeenCalledWith(100, [77]);
  });

  it('TYPING_STARTED: sets typing indicator', async () => {
    await (chatService as any).processControlPacket(
      ControlPacketType.TYPING_STARTED,
      {},
      100,
      99
    );

    expect(mockChatStore.setTyping).toHaveBeenCalledWith(100, 99, true);
  });
});
