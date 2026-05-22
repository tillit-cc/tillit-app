// SignalProtocol is mocked globally via moduleNameMapper -> __mocks__/signal-protocol.ts

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

// Repositories
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

const mockSessionRepo = {
  findByRoom: jest.fn().mockResolvedValue([]),
  findByUserAndRoom: jest.fn().mockResolvedValue(null),
};
jest.mock('@/db/repositories/session.repository', () => ({
  get sessionRepository() {
    return mockSessionRepo;
  },
}));

jest.mock('@/db/repositories/profile.repository', () => ({
  profileRepository: {
    upsert: jest.fn(),
    findByRoom: jest.fn().mockResolvedValue([]),
  },
}));

const mockSocket = {
  onMessage: jest.fn(() => jest.fn()),
  onPacket: jest.fn(() => jest.fn()),
  onStateChange: jest.fn(() => jest.fn()),
  onSenderKeysAvailable: jest.fn(() => jest.fn()),
  onAuthError: jest.fn(() => jest.fn()),
  onUserOnline: jest.fn(() => jest.fn()),
  onRoomDeleted: jest.fn(() => jest.fn()),
  onUserLeftRoom: jest.fn(() => jest.fn()),
  onDeviceLinked: jest.fn(() => jest.fn()),
  onDeviceRevoked: jest.fn(() => jest.fn()),
  onPeerDeviceLinked: jest.fn(() => jest.fn()),
  sendMessage: jest.fn().mockResolvedValue({ success: true }),
  sendPacket: jest.fn().mockResolvedValue({ success: true }),
  isConnected: jest.fn(() => true),
  clearAllServiceHandlers: jest.fn(),
  joinRoom: jest.fn(),
};

const mockApi = {
  getAllRooms: jest.fn().mockResolvedValue({ rooms: [] }),
  getRoomMembers: jest.fn().mockResolvedValue([]),
  createRoom: jest.fn(),
  joinRoom: jest.fn(),
  deleteRoom: jest.fn(),
  deleteMessage: jest.fn(),
  deleteMedia: jest.fn(),
};

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

const mockSessionService = {
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
  refreshRemoteDeviceMap: jest.fn().mockResolvedValue([] as number[]),
  invalidateRemoteDeviceMap: jest.fn(),
};
jest.mock('../session.service', () => ({
  get sessionService() {
    return mockSessionService;
  },
}));

jest.mock('../sender-key.service', () => ({
  senderKeyService: {
    encryptWithSenderKey: jest.fn().mockResolvedValue({ ciphertext: 'sk', distributionId: 'd' }),
    decryptWithSenderKey: jest.fn().mockResolvedValue(JSON.stringify({ text: 'hi' })),
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

const mockChatStore = {
  currentRoomId: null as number | null,
  messages: new Map(),
  allRooms: [] as any[],
  addMessage: jest.fn(),
  updateMessage: jest.fn(),
  removeMessage: jest.fn(),
  setMessages: jest.fn(),
  prependMessages: jest.fn(),
  replaceMessageId: jest.fn(),
  addRoomToList: jest.fn(),
  updateRoomInList: jest.fn(),
  removeRoomFromList: jest.fn(),
  clearRoom: jest.fn(),
  clearAll: jest.fn(),
  setAllRooms: jest.fn(),
  setProfiles: jest.fn(),
  updateProfile: jest.fn(),
  setTyping: jest.fn(),
  setPaginationState: jest.fn(),
};
jest.mock('@/stores/chat.store', () => ({ useChatStore: { getState: jest.fn(() => mockChatStore) } }));
jest.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: jest.fn(() => ({ isAuthenticated: true, userId: 42 })) } }));
jest.mock('@/stores/server.store', () => ({ useServerStore: { getState: jest.fn(() => ({ setConnectionState: jest.fn() })) } }));
jest.mock('@/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/utils/image', () => ({
  generateThumbnailFromBase64: jest.fn(),
  saveImageToFile: jest.fn().mockResolvedValue('/path/img.jpg'),
  deleteImagesByMessageIds: jest.fn(),
  readImageAsBase64: jest.fn(),
}));

import { chatService } from '../chat.service';
import { roomRepository } from '@/db/repositories/room.repository';

const mockRoomRepo = roomRepository as jest.Mocked<typeof roomRepository>;

describe('ChatService — syncRoomMembersAndSessions device-map refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatService.destroy();
    (chatService as any).initialized = false;
    mockSessionService.setSession.mockResolvedValue(true);
    mockSessionService.refreshRemoteDeviceMap.mockResolvedValue([]);
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(null);
  });

  it('refreshes device map for members with an existing session (frontend-0008)', async () => {
    mockRoomRepo.findAllWithMetadata.mockResolvedValue([
      { id: 100, serverId: 1, useSenderKeys: 0 } as any,
    ]);
    mockApi.getRoomMembers.mockResolvedValue([
      { id_user: 99, username: 'alice' },
    ] as any);
    // Peer 99 already has a session in this room → setSession path is skipped.
    mockSessionRepo.findByUserAndRoom.mockResolvedValue({
      id: 1,
      idUser: '99',
      idRoom: 100,
      remoteUserName: 'alice',
      remoteUserDeviceId: 1,
    } as any);

    await chatService.syncRoomMembersAndSessions(1);
    // Refresh runs detached — flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    expect(mockSessionService.setSession).not.toHaveBeenCalled();
    expect(mockSessionService.refreshRemoteDeviceMap).toHaveBeenCalledWith(100, '99');
  });

  it('dedupes refresh per userId across multiple shared rooms', async () => {
    mockRoomRepo.findAllWithMetadata.mockResolvedValue([
      { id: 100, serverId: 1, useSenderKeys: 0 } as any,
      { id: 200, serverId: 1, useSenderKeys: 0 } as any,
    ]);
    mockApi.getRoomMembers.mockResolvedValue([
      { id_user: 99, username: 'alice' },
    ] as any);
    // Peer 99 has sessions in both rooms.
    mockSessionRepo.findByUserAndRoom.mockResolvedValue({
      id: 1,
      idUser: '99',
      idRoom: 100,
      remoteUserName: 'alice',
      remoteUserDeviceId: 1,
    } as any);

    await chatService.syncRoomMembersAndSessions(1);
    await new Promise((r) => setImmediate(r));

    // Two rooms × same peer = 1 refresh call for the peer, not 2.
    // (A separate ownUserId refresh fires once per sync — see the
    // dedicated `refreshes deviceMap[ownUserId] once per sync` test.)
    const peerCalls = (mockSessionService.refreshRemoteDeviceMap as jest.Mock).mock.calls.filter(
      (c) => c[1] === '99',
    );
    expect(peerCalls).toHaveLength(1);
  });

  it('refreshes deviceMap[ownUserId] once per sync so encrypt() can self-fanout (frontend-0013)', async () => {
    mockRoomRepo.findAllWithMetadata.mockResolvedValue([
      { id: 100, serverId: 1, useSenderKeys: 0 } as any,
      { id: 200, serverId: 1, useSenderKeys: 0 } as any,
    ]);
    mockApi.getRoomMembers.mockResolvedValue([] as any);

    await chatService.syncRoomMembersAndSessions(1);
    await new Promise((r) => setImmediate(r));

    // GET /chat/:id/members filters the requester out, so the per-member
    // loop never covers our own user — without the explicit self refresh,
    // the self-fanout loop in encrypt() would silently skip and our linked
    // devices would not receive a copy of what we send.
    const selfCalls = (mockSessionService.refreshRemoteDeviceMap as jest.Mock).mock.calls.filter(
      (c) => c[1] === '42',
    );
    expect(selfCalls).toHaveLength(1);
    expect(selfCalls[0][2]).toEqual({ force: true });
  });

  describe('peerDeviceLinked handler', () => {
    it('invalidates the deviceMap for the linked peer and refreshes eagerly when a shared room exists', async () => {
      mockRoomRepo.findAllWithMetadata.mockResolvedValue([
        { id: 100, serverId: 1, useSenderKeys: 0 } as any,
      ]);

      // Trigger the handler registration
      chatService.init();

      // Grab the callback the chat service passed to socket.onPeerDeviceLinked
      const calls = (mockSocket.onPeerDeviceLinked as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const handler = calls[calls.length - 1][0] as (data: any) => Promise<void>;

      await handler({ userId: 99, addedDeviceId: 2, linkedAt: '2026-05-21T10:00:00Z' });

      expect(mockSessionService.invalidateRemoteDeviceMap).toHaveBeenCalledWith('99');
      expect(mockSessionService.refreshRemoteDeviceMap).toHaveBeenCalledWith(
        100,
        '99',
        { force: true },
      );
    });

    it('invalidates even when no shared room is locally known (skips eager refresh)', async () => {
      mockRoomRepo.findAllWithMetadata.mockResolvedValue([]);

      chatService.init();

      const calls = (mockSocket.onPeerDeviceLinked as jest.Mock).mock.calls;
      const handler = calls[calls.length - 1][0] as (data: any) => Promise<void>;

      await handler({ userId: 99, addedDeviceId: 2, linkedAt: '2026-05-21T10:00:00Z' });

      expect(mockSessionService.invalidateRemoteDeviceMap).toHaveBeenCalledWith('99');
      expect(mockSessionService.refreshRemoteDeviceMap).not.toHaveBeenCalled();
    });
  });

  it('does not refresh device map for brand-new members (setSession path covers it)', async () => {
    mockRoomRepo.findAllWithMetadata.mockResolvedValue([
      { id: 100, serverId: 1, useSenderKeys: 0 } as any,
    ]);
    mockApi.getRoomMembers.mockResolvedValue([
      { id_user: 77, username: 'bob' },
    ] as any);
    // No prior session — setSession() will fetch /keys and populate the map.
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(null);

    await chatService.syncRoomMembersAndSessions(1);
    await new Promise((r) => setImmediate(r));

    expect(mockSessionService.setSession).toHaveBeenCalledWith(
      100,
      77,
      'bob',
      1,
    );
    // The setSession path covers brand-new peers, so no per-peer refresh
    // should fire for user 77. (The ownUserId refresh is unrelated and is
    // exercised in `refreshes deviceMap[ownUserId] once per sync`.)
    const peerCalls = (mockSessionService.refreshRemoteDeviceMap as jest.Mock).mock.calls.filter(
      (c) => c[1] === '77',
    );
    expect(peerCalls).toHaveLength(0);
  });
});
