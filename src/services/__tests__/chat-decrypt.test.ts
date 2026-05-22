import { MessageStatus, ControlPacketType, UserMessageType } from '@/types/message';

// SignalProtocol is mocked globally via moduleNameMapper → __mocks__/signal-protocol.ts

// Mock expo-haptics
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

// Mocks for repositories
const mockMessageRepo = { create: jest.fn(), findById: jest.fn().mockResolvedValue(null), findByRoom: jest.fn().mockResolvedValue([]), updateStatus: jest.fn(), updateBody: jest.fn(), findStuckSending: jest.fn().mockResolvedValue([]), replaceId: jest.fn(), delete: jest.fn(), markAsRead: jest.fn(), findByRoomAndType: jest.fn().mockResolvedValue([]) };
const mockRoomRepo = { findById: jest.fn().mockResolvedValue(null), upsert: jest.fn(), update: jest.fn(), delete: jest.fn(), hardDelete: jest.fn(), findAllWithMetadata: jest.fn().mockResolvedValue([]) };
const mockSessionRepo = { findByRoom: jest.fn().mockResolvedValue([]), findByUserAndRoom: jest.fn().mockResolvedValue(null) };
const mockProfileRepo = { upsert: jest.fn(), findByRoom: jest.fn().mockResolvedValue([]) };

jest.mock('@/db/repositories/message.repository', () => ({ messageRepository: mockMessageRepo }));
jest.mock('@/db/repositories/room.repository', () => ({ roomRepository: mockRoomRepo }));
jest.mock('@/db/repositories/session.repository', () => ({ sessionRepository: mockSessionRepo }));
jest.mock('@/db/repositories/profile.repository', () => ({ profileRepository: mockProfileRepo }));

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
import { sessionService } from '../session.service';

describe('ChatService — decrypt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
  });

  it('returns decrypted text on success', async () => {
    const plaintext = JSON.stringify({ text: 'hello world' });
    (SignalProtocol as any).decryptMessage.mockResolvedValue({
      message: encodeURIComponent(plaintext),
    });

    const result = await (chatService as any).decrypt('encrypted-body', 100, 99);

    expect(result).toBe(plaintext);
    expect((SignalProtocol as any).decryptMessage).toHaveBeenCalledWith(
      'encrypted-body',
      '99',
      null,
    );
  });

  it('calls ensureSessionInDatabase after successful decrypt', async () => {
    const plaintext = JSON.stringify({ text: 'hello' });
    (SignalProtocol as any).decryptMessage.mockResolvedValue({
      message: encodeURIComponent(plaintext),
    });

    await (chatService as any).decrypt('encrypted-body', 100, 99);

    expect(sessionService.ensureSessionInDatabase).toHaveBeenCalledWith(100, '99', undefined);
    expect(sessionService.updateSessionTimestamp).toHaveBeenCalledWith(100, '99');
  });

  it('Error 6 (InvalidMessage): does NOT call recoverSession, returns false', async () => {
    (SignalProtocol as any).decryptMessage.mockRejectedValue(
      new Error('SignalError 6: InvalidMessage')
    );

    const result = await (chatService as any).decrypt('encrypted-body', 100, 99);

    expect(result).toBe(false);
    // Error 6: must NOT recover the session to preserve in-flight messages
    expect(sessionService.recoverSession).not.toHaveBeenCalled();
    expect(sessionService.handleIdentityKeyChanged).not.toHaveBeenCalled();
  });

  it('Error 11 (invalidKey): calls recoverSession, returns false', async () => {
    (SignalProtocol as any).decryptMessage.mockRejectedValue(
      new Error('SignalError error 11: invalidKey')
    );

    const result = await (chatService as any).decrypt('encrypted-body', 100, 99);

    expect(result).toBe(false);
    // Error 11: should recover the session
    expect(sessionService.recoverSession).toHaveBeenCalledWith(100, '99', 'user-99');
    // Should also attempt to refresh pre-keys
    expect(sessionService.refreshPreKeysIfNeeded).toHaveBeenCalled();
  });

  it('Error 12 (UntrustedIdentity): calls handleIdentityKeyChanged, returns false', async () => {
    (SignalProtocol as any).decryptMessage.mockRejectedValue(
      new Error('SignalError 12: UntrustedIdentity')
    );

    const result = await (chatService as any).decrypt('encrypted-body', 100, 99);

    expect(result).toBe(false);
    // Error 12: possible MITM, should handle identity key change
    expect(sessionService.handleIdentityKeyChanged).toHaveBeenCalledWith(100, 99);
    // Should NOT recover the session
    expect(sessionService.recoverSession).not.toHaveBeenCalled();
  });
});
