import {
  createMockSenderKeyRepository,
  createMockRoomRepository,
} from '@/__tests__/helpers/mock-repositories';
import { toBackendRoomId } from '@/utils/server-id';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockApi = {
  post: jest.fn(),
  put: jest.fn(),
  get: jest.fn(),
  getRoomMembers: jest.fn().mockResolvedValue([]),
  fetchPendingSenderKeys: jest.fn().mockResolvedValue({ distributions: [] }),
  uploadSenderKeyDistribution: jest.fn().mockResolvedValue(undefined),
};

jest.mock('./server-registry', () => ({
  serverRegistry: {
    getApiForRoom: jest.fn(() => mockApi),
    getUserIdForRoom: jest.fn(() => 42),
  },
}));

jest.mock('./session.service', () => ({
  sessionService: { ensureSession: jest.fn().mockResolvedValue(true) },
}));

let mockSenderKeyRepo = createMockSenderKeyRepository();
jest.mock('@/db/repositories/sender-key.repository', () => ({
  get senderKeyRepository() {
    return mockSenderKeyRepo;
  },
}));

let mockRoomRepo = createMockRoomRepository();
jest.mock('@/db/repositories/room.repository', () => ({
  get roomRepository() {
    return mockRoomRepo;
  },
}));

jest.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: jest.fn(() => ({ userId: 42 })) },
}));

jest.mock('@/stores/chat.store', () => ({
  useChatStore: {
    getState: jest.fn(() => ({
      updateRoomInList: jest.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import SignalProtocol from 'signal-protocol';
import { senderKeyService } from './sender-key.service';
import { senderKeyRepository } from '@/db/repositories/sender-key.repository';
import { roomRepository } from '@/db/repositories/room.repository';
import { sessionService } from './session.service';
import { useAuthStore } from '@/stores/auth.store';
import {
  SENDER_KEY_MESSAGE_ROTATION_THRESHOLD,
  SENDER_KEY_DAYS_ROTATION_THRESHOLD,
} from '@/config/app.config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOM_ID = 10;
const BACKEND_ROOM_ID = toBackendRoomId(ROOM_ID);

function mockOwnUserId(userId: number | null) {
  (useAuthStore.getState as jest.Mock).mockReturnValue({ userId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SenderKeyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSenderKeyRepo = createMockSenderKeyRepository();
    mockRoomRepo = createMockRoomRepository();
    mockOwnUserId(42);
  });

  // ========================================
  // shouldUseSenderKeys
  // ========================================

  describe('shouldUseSenderKeys', () => {
    it('returns true when room.useSenderKeys === 1', async () => {
      (roomRepository.findById as jest.Mock).mockResolvedValueOnce({ id: ROOM_ID, useSenderKeys: 1 });

      const result = await senderKeyService.shouldUseSenderKeys(ROOM_ID);
      expect(result).toBe(true);
    });

    it('returns false when room not found', async () => {
      (roomRepository.findById as jest.Mock).mockResolvedValueOnce(null);

      const result = await senderKeyService.shouldUseSenderKeys(ROOM_ID);
      expect(result).toBe(false);
    });
  });

  // ========================================
  // hasSenderKeySession
  // ========================================

  describe('hasSenderKeySession', () => {
    it('returns true when session exists', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        distributionId: 'dist-1',
      });

      const result = await senderKeyService.hasSenderKeySession(ROOM_ID, 42);
      expect(result).toBe(true);
    });

    it('returns false when no session', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce(null);

      const result = await senderKeyService.hasSenderKeySession(ROOM_ID, 42);
      expect(result).toBe(false);
    });
  });

  // ========================================
  // initializeSenderKeys
  // ========================================

  describe('initializeSenderKeys', () => {
    it('calls API init, creates session, distributes, updates room', async () => {
      const memberIds = [100, 101];
      mockApi.post.mockResolvedValueOnce({ distributionId: 'dist-abc' });
      mockApi.uploadSenderKeyDistribution.mockResolvedValueOnce(undefined);

      await senderKeyService.initializeSenderKeys(ROOM_ID, memberIds);

      // API init call
      expect(mockApi.post).toHaveBeenCalledWith(`sender-keys/initialize/${BACKEND_ROOM_ID}`, {});

      // Native session creation
      expect(SignalProtocol.createSenderKeySession).toHaveBeenCalledWith(String(ROOM_ID), 'dist-abc');

      // DB session upsert
      expect(senderKeyRepository.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          idRoom: ROOM_ID,
          senderUserId: 42,
          distributionId: 'dist-abc',
          chainVersion: 1,
          messageCount: 0,
        }),
      );

      // Room updated
      expect(roomRepository.update).toHaveBeenCalledWith(ROOM_ID, { useSenderKeys: 1 });

      // Distribution uploaded
      expect(mockApi.uploadSenderKeyDistribution).toHaveBeenCalledWith(
        BACKEND_ROOM_ID,
        'dist-abc',
        expect.any(Array),
      );
    });

    it('throws if no userId', async () => {
      mockOwnUserId(null);

      await expect(senderKeyService.initializeSenderKeys(ROOM_ID, [100])).rejects.toThrow(
        'Missing sender user id',
      );
    });
  });

  // ========================================
  // distributeSenderKey (via initializeSenderKeys)
  // ========================================

  describe('distributeSenderKey', () => {
    it('encrypts for each member', async () => {
      const memberIds = [100, 101, 102];
      mockApi.post.mockResolvedValueOnce({ distributionId: 'dist-xyz' });
      mockApi.uploadSenderKeyDistribution.mockResolvedValueOnce(undefined);

      await senderKeyService.initializeSenderKeys(ROOM_ID, memberIds);

      // ensureSession called for each member
      expect(sessionService.ensureSession).toHaveBeenCalledTimes(3);
      expect(sessionService.ensureSession).toHaveBeenCalledWith(ROOM_ID, 100);
      expect(sessionService.ensureSession).toHaveBeenCalledWith(ROOM_ID, 101);
      expect(sessionService.ensureSession).toHaveBeenCalledWith(ROOM_ID, 102);

      // encryptMessage called for each member
      expect(SignalProtocol.encryptMessage).toHaveBeenCalledTimes(3);
      expect(SignalProtocol.encryptMessage).toHaveBeenCalledWith(
        encodeURIComponent('mockDistributionMessage'),
        '100',
      );
      expect(SignalProtocol.encryptMessage).toHaveBeenCalledWith(
        encodeURIComponent('mockDistributionMessage'),
        '101',
      );
      expect(SignalProtocol.encryptMessage).toHaveBeenCalledWith(
        encodeURIComponent('mockDistributionMessage'),
        '102',
      );

      // Upload contains 3 distributions
      const uploadCall = mockApi.uploadSenderKeyDistribution.mock.calls[0];
      expect(uploadCall[2]).toHaveLength(3);
    });

    it('tracks failed distributions', async () => {
      const memberIds = [100, 101];
      mockApi.post.mockResolvedValueOnce({ distributionId: 'dist-fail' });
      mockApi.uploadSenderKeyDistribution.mockResolvedValueOnce(undefined);

      // First member succeeds, second fails
      (SignalProtocol.encryptMessage as jest.Mock)
        .mockResolvedValueOnce({ encryptedMessage: 'enc-ok' })
        .mockRejectedValueOnce(new Error('encrypt failed'));

      await senderKeyService.initializeSenderKeys(ROOM_ID, memberIds);

      // Only successful distribution uploaded
      const uploadCall = mockApi.uploadSenderKeyDistribution.mock.calls[0];
      expect(uploadCall[2]).toHaveLength(1);
      expect(uploadCall[2][0].recipientUserId).toBe(100);

      // Failed distribution tracked in retry queue
      expect(senderKeyRepository.addToRetryQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM_ID,
          senderUserId: 42,
          recipientUserId: 101,
          distributionId: 'dist-fail',
        }),
      );
    });
  });

  // ========================================
  // fetchAndProcessPendingSenderKeys
  // ========================================

  describe('fetchAndProcessPendingSenderKeys', () => {
    it('decrypts and processes distributions', async () => {
      mockApi.fetchPendingSenderKeys.mockResolvedValueOnce({
        distributions: [
          {
            id: 1,
            senderUserId: 99,
            distributionId: 'dist-remote',
            encryptedSenderKey: 'encrypted-key-data',
          },
        ],
      });

      // decryptMessage returns URI-encoded distribution message
      (SignalProtocol.decryptMessage as jest.Mock).mockResolvedValueOnce({
        message: encodeURIComponent('remote-dist-msg'),
      });

      await senderKeyService.fetchAndProcessPendingSenderKeys(ROOM_ID);

      // Decrypt the encrypted sender key
      expect(SignalProtocol.decryptMessage).toHaveBeenCalledWith('encrypted-key-data', '99');

      // Process the distribution
      expect(SignalProtocol.processSenderKeyDistribution).toHaveBeenCalledWith(
        String(ROOM_ID),
        '99',
        'remote-dist-msg',
      );

      // Upsert session
      expect(senderKeyRepository.upsertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          idRoom: ROOM_ID,
          senderUserId: 99,
          distributionId: 'dist-remote',
        }),
      );
    });

    it('marks delivered after processing', async () => {
      mockApi.fetchPendingSenderKeys.mockResolvedValueOnce({
        distributions: [
          {
            id: 5,
            senderUserId: 88,
            distributionId: 'dist-5',
            encryptedSenderKey: 'enc-5',
          },
          {
            id: 6,
            senderUserId: 89,
            distributionId: 'dist-6',
            encryptedSenderKey: 'enc-6',
          },
        ],
      });

      (SignalProtocol.decryptMessage as jest.Mock)
        .mockResolvedValueOnce({ message: encodeURIComponent('dist-msg-5') })
        .mockResolvedValueOnce({ message: encodeURIComponent('dist-msg-6') });

      await senderKeyService.fetchAndProcessPendingSenderKeys(ROOM_ID);

      // Mark both as delivered
      expect(mockApi.put).toHaveBeenCalledWith('sender-keys/mark-delivered', {
        distributionIds: [5, 6],
      });

      // Room updated with useSenderKeys
      expect(roomRepository.update).toHaveBeenCalledWith(ROOM_ID, { useSenderKeys: 1 });
    });
  });

  // ========================================
  // encryptWithSenderKey
  // ========================================

  describe('encryptWithSenderKey', () => {
    it('encrypts using sender key session', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValue({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        distributionId: 'dist-enc',
        messageCount: 0,
        created: Date.now() / 1000,
      });

      const result = await senderKeyService.encryptWithSenderKey(ROOM_ID, 'hello group');

      expect(SignalProtocol.encryptGroupMessage).toHaveBeenCalledWith(
        'hello group',
        String(ROOM_ID),
        'dist-enc',
      );
      expect(result).toEqual({ ciphertext: 'group-encrypted:hello group', distributionId: 'dist-enc' });
      expect(senderKeyRepository.incrementMessageCount).toHaveBeenCalledWith(1);
    });

    it('throws if no session', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValue(null);

      await expect(senderKeyService.encryptWithSenderKey(ROOM_ID, 'msg')).rejects.toThrow(
        'No sender key session for room',
      );
    });

    it('rotates if shouldRotateSenderKey returns true', async () => {
      // First call from encryptWithSenderKey to check session existence
      // Second call from shouldRotateSenderKey
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValue({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        distributionId: 'dist-old',
        messageCount: SENDER_KEY_MESSAGE_ROTATION_THRESHOLD, // triggers rotation
        chainVersion: 1,
        created: Date.now() / 1000,
      });

      // rotateSenderKey calls api.post for rotate endpoint
      mockApi.post.mockResolvedValueOnce({ distributionId: 'dist-rotated' });
      mockApi.getRoomMembers.mockResolvedValueOnce([
        { id_user: 100 },
        { id_user: 101 },
      ]);
      mockApi.uploadSenderKeyDistribution.mockResolvedValueOnce(undefined);

      await senderKeyService.encryptWithSenderKey(ROOM_ID, 'after rotation');

      // rotateSenderKey was called
      expect(mockApi.post).toHaveBeenCalledWith(`sender-keys/rotate/${BACKEND_ROOM_ID}`, {});
      expect(SignalProtocol.rotateSenderKey).toHaveBeenCalledWith(String(ROOM_ID));

      // After rotation, encrypt still happens
      expect(SignalProtocol.encryptGroupMessage).toHaveBeenCalled();
    });
  });

  // ========================================
  // decryptWithSenderKey
  // ========================================

  describe('decryptWithSenderKey', () => {
    it('decrypts using sender key', async () => {
      const result = await senderKeyService.decryptWithSenderKey(ROOM_ID, 99, 'group-ciphertext');

      expect(SignalProtocol.decryptGroupMessage).toHaveBeenCalledWith(
        'group-ciphertext',
        String(ROOM_ID),
        '99',
      );
      expect(result).toBe('group-decrypted');
    });
  });

  // ========================================
  // shouldRotateSenderKey
  // ========================================

  describe('shouldRotateSenderKey', () => {
    it('returns true when messageCount >= 1000', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        messageCount: SENDER_KEY_MESSAGE_ROTATION_THRESHOLD,
        created: Date.now() / 1000, // fresh, so age is not the trigger
      });

      const result = await senderKeyService.shouldRotateSenderKey(ROOM_ID);
      expect(result).toBe(true);
    });

    it('returns true when age >= 7 days (in seconds)', async () => {
      const eightDaysAgoSeconds = Date.now() / 1000 - SENDER_KEY_DAYS_ROTATION_THRESHOLD - 1;

      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        messageCount: 0,
        created: eightDaysAgoSeconds,
      });

      const result = await senderKeyService.shouldRotateSenderKey(ROOM_ID);
      expect(result).toBe(true);
    });

    it('returns false when within limits', async () => {
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        messageCount: 10,
        created: Date.now() / 1000, // just created
      });

      const result = await senderKeyService.shouldRotateSenderKey(ROOM_ID);
      expect(result).toBe(false);
    });
  });

  // ========================================
  // handleMemberLeft
  // ========================================

  describe('handleMemberLeft', () => {
    it('triggers rotation when sender keys are active', async () => {
      // shouldUseSenderKeys returns true
      (roomRepository.findById as jest.Mock).mockResolvedValueOnce({ id: ROOM_ID, useSenderKeys: 1 });

      // getRoomMembers for the rotation
      mockApi.getRoomMembers.mockResolvedValueOnce([
        { id_user: 100 },
        { id_user: 101 },
      ]);

      // rotateSenderKey -> api.post for rotate
      mockApi.post.mockResolvedValueOnce({ distributionId: 'dist-after-left' });
      mockApi.uploadSenderKeyDistribution.mockResolvedValueOnce(undefined);

      // rotateSenderKey needs existing session for updateChainVersion
      (senderKeyRepository.findSessionByRoomAndSender as jest.Mock).mockResolvedValueOnce({
        id: 1,
        idRoom: ROOM_ID,
        senderUserId: 42,
        chainVersion: 2,
      });

      await senderKeyService.handleMemberLeft(ROOM_ID);

      // Rotate was called
      expect(mockApi.post).toHaveBeenCalledWith(`sender-keys/rotate/${BACKEND_ROOM_ID}`, {});
      expect(SignalProtocol.rotateSenderKey).toHaveBeenCalledWith(String(ROOM_ID));

      // Distribution sent to remaining members (excluding self=42)
      expect(mockApi.uploadSenderKeyDistribution).toHaveBeenCalledWith(
        BACKEND_ROOM_ID,
        'dist-after-left',
        expect.any(Array),
      );

      // Chain version updated
      expect(senderKeyRepository.updateChainVersion).toHaveBeenCalledWith(1, 3);
    });
  });
});
