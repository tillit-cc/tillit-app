/**
 * Factory functions for mocking all repository modules.
 * Usage: jest.mock('@/db/repositories/message.repository', () => ({ messageRepository: createMockMessageRepository() }));
 */

export function createMockMessageRepository() {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
    findByRoom: jest.fn().mockResolvedValue([]),
    findReplies: jest.fn().mockResolvedValue([]),
    findByStatus: jest.fn().mockResolvedValue([]),
    findByRoomAndType: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    markAsRead: jest.fn().mockResolvedValue(undefined),
    updateBody: jest.fn().mockResolvedValue(undefined),
    getUnreadCount: jest.fn().mockResolvedValue(0),
    getLastMessageTimestamp: jest.fn().mockResolvedValue(null),
    updateAllByStatus: jest.fn().mockResolvedValue(undefined),
    findStuckSending: jest.fn().mockResolvedValue([]),
    replaceId: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByRoom: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockRoomRepository() {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
    findByInviteCode: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    findAllWithMetadata: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    hardDelete: jest.fn().mockResolvedValue(undefined),
    findByServerId: jest.fn().mockResolvedValue([]),
    hardDeleteByServerId: jest.fn().mockResolvedValue([]),
  };
}

export function createMockSessionRepository() {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
    findByUserAndRoom: jest.fn().mockResolvedValue(null),
    findByUserRoomAndDevice: jest.fn().mockResolvedValue(null),
    findAll: jest.fn().mockResolvedValue([]),
    findByRoom: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
    updateLastMessageAt: jest.fn().mockResolvedValue(undefined),
    markIdentityVerified: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByUserAndRoom: jest.fn().mockResolvedValue(undefined),
    deleteByRoom: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    updateRemoteKnownDevicesForUser: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockProfileRepository() {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue(null),
    findByUser: jest.fn().mockResolvedValue(null),
    findByUserAndRoom: jest.fn().mockResolvedValue(null),
    findByRoom: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByRoom: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockSenderKeyRepository() {
  return {
    createSession: jest.fn().mockResolvedValue(undefined),
    findSessionByRoomAndSender: jest.fn().mockResolvedValue(null),
    findSessionsByRoom: jest.fn().mockResolvedValue([]),
    upsertSession: jest.fn().mockResolvedValue(undefined),
    incrementMessageCount: jest.fn().mockResolvedValue(undefined),
    updateChainVersion: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    deleteSessionsByRoom: jest.fn().mockResolvedValue(undefined),
    addToRetryQueue: jest.fn().mockResolvedValue(undefined),
    findRetryQueueItem: jest.fn().mockResolvedValue(null),
    findRetryQueueByRecipient: jest.fn().mockResolvedValue([]),
    findRetryQueueByRoom: jest.fn().mockResolvedValue([]),
    removeFromRetryQueue: jest.fn().mockResolvedValue(undefined),
    clearRetryQueueByRoom: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockServerRepository() {
  return {
    findAll: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    findDefault: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 1, name: 'Test', apiUrl: 'https://api.test.com', socketUrl: 'https://api.test.com', socketNamespace: '/chat', isDefault: 1, status: 1, userId: null }),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

export function createMockIdentityRepository() {
  return {
    findByUser: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}
