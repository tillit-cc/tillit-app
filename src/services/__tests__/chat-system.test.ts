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
import { sessionService } from '../session.service';
import { senderKeyService } from '../sender-key.service';
import { messageRepository } from '@/db/repositories/message.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { sessionRepository } from '@/db/repositories/session.repository';
import { profileRepository } from '@/db/repositories/profile.repository';
import { deleteImagesByMessageIds } from '@/utils/image';

// Typed references to the mocked repositories for assertions
const mockMessageRepo = messageRepository as jest.Mocked<typeof messageRepository>;
const mockRoomRepo = roomRepository as jest.Mocked<typeof roomRepository>;
const mockSessionRepo = sessionRepository as jest.Mocked<typeof sessionRepository>;
const mockProfileRepo = profileRepository as jest.Mocked<typeof profileRepository>;

describe('ChatService — handleSystemMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
    mockChatStore.currentRoomId = null;
    mockChatStore.messages = new Map();
    mockChatStore.allRooms = [];
  });

  function makeSystemEnvelope(type: string, payload: any, roomId = 100): any {
    return {
      id: `sys-${Date.now()}`,
      timestamp: Date.now(),
      category: 'system',
      type,
      payload,
      id_room: roomId,
      id_user_from: 0,
      version: '2.0',
    };
  }

  it('user_joined: upserts profile', async () => {
    const envelope = makeSystemEnvelope('user_joined', {
      user_id: 77,
      username: 'Alice',
    });

    await (chatService as any).handleSystemMessage(envelope, 100);

    expect(mockProfileRepo.upsert).toHaveBeenCalledWith({
      idUser: 77,
      idRoom: 100,
      username: 'Alice',
    });
  });

  it('user_joined: establishes session with new member (skip self)', async () => {
    // The new member is NOT us (42), so session should be established
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(undefined);
    (sessionService.setSession as jest.Mock).mockResolvedValue(true);
    mockRoomRepo.findById.mockResolvedValue({ id: 100, useSenderKeys: 0 } as any);

    const envelope = makeSystemEnvelope('user_joined', {
      user_id: 77,
      username: 'Alice',
    });

    await (chatService as any).handleSystemMessage(envelope, 100);

    // Should establish session with the new member
    expect(sessionService.setSession).toHaveBeenCalledWith(100, 77, 'Alice', 1);

    // Should update the room's hasSession flag
    expect(mockChatStore.updateRoomInList).toHaveBeenCalledWith(100, { hasSession: true });
  });

  it('room_deleted: deletes room from DB and store', async () => {
    mockMessageRepo.findByRoomAndType.mockResolvedValue([]);

    const envelope = makeSystemEnvelope('room_deleted', {});

    await (chatService as any).handleSystemMessage(envelope, 100);

    // Should delete the room from the database
    expect(mockRoomRepo.delete).toHaveBeenCalledWith(100);

    // Should remove from the store
    expect(mockChatStore.removeRoomFromList).toHaveBeenCalledWith(100);
    expect(mockChatStore.clearRoom).toHaveBeenCalledWith(100);
  });

  it('room_renamed: updates room name', async () => {
    const envelope = makeSystemEnvelope('room_renamed', {
      newName: 'Updated Room Name',
    });

    await (chatService as any).handleSystemMessage(envelope, 100);

    // Should update name in DB
    expect(mockRoomRepo.update).toHaveBeenCalledWith(100, { name: 'Updated Room Name' });

    // Should update name in store
    expect(mockChatStore.updateRoomInList).toHaveBeenCalledWith(100, { name: 'Updated Room Name' });
  });

  it('message_deleted: deletes message from DB and store', async () => {
    // The message exists in the DB
    mockMessageRepo.findById.mockResolvedValue({
      id: 'msg-to-delete',
      type: UserMessageType.TEXT,
      body: 'Some text',
      idRoom: 100,
    } as any);

    // Mock findByRoom for refreshRoomLastMessage
    mockMessageRepo.findByRoom.mockResolvedValue([]);

    const envelope = makeSystemEnvelope('message_deleted', {
      message_id: 'msg-to-delete',
    });

    await (chatService as any).handleSystemMessage(envelope, 100);

    // Should delete from DB
    expect(mockMessageRepo.delete).toHaveBeenCalledWith('msg-to-delete');

    // Should remove from store
    expect(mockChatStore.removeMessage).toHaveBeenCalledWith(100, 'msg-to-delete');
  });
});
