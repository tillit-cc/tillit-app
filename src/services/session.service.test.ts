import SignalProtocol from 'signal-protocol';
import {
  createMockSessionRepository,
  createMockProfileRepository,
} from '@/__tests__/helpers/mock-repositories';
import {
  createMockAuthStoreState,
  createMockAppStoreState,
} from '@/__tests__/helpers/mock-stores';

// ============================================================================
// Mock API
// ============================================================================

const mockApi = {
  getRemoteKeys: jest.fn().mockResolvedValue({
    registrationId: 1234,
    identityPublicKey: 'idKey==',
    deviceId: 1,
    preKey: { keyId: 5, keyData: 'pk==', deviceId: 1 },
    signedPreKey: { keyId: 1, keyData: 'spk==', signature: 'sig==' },
    kyberPreKey: { keyId: 7, keyData: 'kpk==', signature: 'ksig==', deviceId: 1 },
  }),
  getKeyStatus: jest.fn().mockResolvedValue({ preKeysCount: 50, kyberPreKeysCount: 50 }),
  syncPublicKeys: jest.fn().mockResolvedValue(undefined),
  getToken: jest.fn().mockResolvedValue('mock-token'),
};

// ============================================================================
// Mocks
// ============================================================================

let mockSessionRepo = createMockSessionRepository();
let mockProfileRepo = createMockProfileRepository();
let mockAuthState = createMockAuthStoreState();
let mockAppState = createMockAppStoreState();

jest.mock('@/db/repositories/session.repository', () => ({
  get sessionRepository() {
    return mockSessionRepo;
  },
}));

jest.mock('@/db/repositories/profile.repository', () => ({
  get profileRepository() {
    return mockProfileRepo;
  },
}));

jest.mock('@/stores/auth.store', () => ({
  useAuthStore: { getState: jest.fn(() => mockAuthState) },
}));

jest.mock('@/stores/app.store', () => ({
  useAppStore: { getState: jest.fn(() => mockAppState) },
}));

jest.mock('./server-registry', () => ({
  serverRegistry: {
    getApiForRoom: jest.fn(() => mockApi),
    getApi: jest.fn(() => mockApi),
    getUserIdForRoom: jest.fn(() => 42),
    getAllServers: jest.fn(() => [{ id: 1 }]),
  },
}));

jest.mock('@/utils/server-id', () => ({
  getServerIdFromRoomId: jest.fn((roomId: number) => Math.floor(roomId / 1_000_000_000)),
}));

// ============================================================================
// Import service AFTER mocks are set up
// ============================================================================

import { sessionService, IdentityKeyMismatchError } from './session.service';
import { serverRegistry } from './server-registry';

// ============================================================================
// Helpers
// ============================================================================

/** Reset the singleton's internal state between tests. */
function resetServiceState() {
  sessionService.sessions.clear();
  // Reset private fields via any-cast
  (sessionService as any).lastPreKeyId = 0;
  (sessionService as any).lastKyberPreKeyId = 0;
  (sessionService as any).lastSignedPreKeyRotation = 0;
  (sessionService as any).refreshLocks = new Set();
  (sessionService as any).lastRefreshTime = new Map();
  (sessionService as any).deviceId = 1;
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    idUser: '99',
    idRoom: 10,
    remoteUserName: 'alice',
    remoteUserDeviceId: 1,
    created: 1000,
    lastModified: 1000,
    lastMessageAt: null,
    identityVerified: 0,
    ...overrides,
  };
}

// ============================================================================
// Test suite
// ============================================================================

describe('SessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Rebuild fresh mocks each test
    mockSessionRepo = createMockSessionRepository();
    mockProfileRepo = createMockProfileRepository();
    mockAuthState = createMockAuthStoreState();
    mockAppState = createMockAppStoreState();

    // Re-wire default API mock responses
    mockApi.getRemoteKeys.mockResolvedValue({
      registrationId: 1234,
      identityPublicKey: 'idKey==',
      deviceId: 1,
      preKey: { keyId: 5, keyData: 'pk==', deviceId: 1 },
      signedPreKey: { keyId: 1, keyData: 'spk==', signature: 'sig==' },
      kyberPreKey: { keyId: 7, keyData: 'kpk==', signature: 'ksig==', deviceId: 1 },
    });
    mockApi.getKeyStatus.mockResolvedValue({ preKeysCount: 50, kyberPreKeysCount: 50 });
    mockApi.syncPublicKeys.mockResolvedValue(undefined);
    mockApi.getToken.mockResolvedValue('mock-token');

    resetServiceState();
  });

  // ==========================================================================
  // 1. setSession: blocks self-session (remoteUserId === ownUserId)
  // ==========================================================================
  it('setSession blocks self-session when remoteUserId equals ownUserId', async () => {
    const result = await sessionService.setSession(10, 42, 'self');
    expect(result).toBe(false);
    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 2. setSession: resumes existing session if found in DB
  // ==========================================================================
  it('setSession resumes existing session if found in DB', async () => {
    const session = makeSession({ idUser: '99', idRoom: 10 });
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(session);

    const result = await sessionService.setSession(10, 99, 'alice');
    expect(result).toBe(true);
    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('99', 'alice', 1);
    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 3. setSession: returns false when remote keys fetch fails
  // ==========================================================================
  it('setSession returns false when remote keys fetch fails', async () => {
    mockApi.getRemoteKeys.mockRejectedValue(new Error('network error'));

    const result = await sessionService.setSession(10, 99, 'alice');
    expect(result).toBe(false);
  });

  // ==========================================================================
  // 4. setSession: returns false when remote keys are null
  // ==========================================================================
  it('setSession returns false when remote keys are null', async () => {
    mockApi.getRemoteKeys.mockResolvedValue(null);

    const result = await sessionService.setSession(10, 99, 'alice');
    expect(result).toBe(false);
  });

  // ==========================================================================
  // 5. setSession: returns false when pre-keys missing in response
  // ==========================================================================
  it('setSession returns false when pre-keys are missing in response', async () => {
    mockApi.getRemoteKeys.mockResolvedValue({
      registrationId: 1234,
      identityPublicKey: 'idKey==',
      deviceId: 1,
      // Missing preKey, signedPreKey, kyberPreKey
    });

    const result = await sessionService.setSession(10, 99, 'alice');
    expect(result).toBe(false);
    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 6. setSession: success path
  // ==========================================================================
  it('setSession success path calls setRemoteUserKeys, establishSession, upserts DB', async () => {
    mockSessionRepo.findByRoom.mockResolvedValue([]);

    const result = await sessionService.setSession(10, 99, 'alice');

    expect(result).toBe(true);
    expect(SignalProtocol.setRemoteUserKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUserId: '99',
        preKeyId: 5,
        preKeyPublicKey: 'pk==',
        signedPreKeyId: 1,
        signedPreKeyPublicKey: 'spk==',
        signedPreKeySignature: 'sig==',
        identityPublicKey: 'idKey==',
        registrationId: 1234,
        deviceId: 1,
        kyberPreKeyId: 7,
        kyberPreKeyPublicKey: 'kpk==',
        kyberPreKeySignature: 'ksig==',
      })
    );
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
    expect(mockSessionRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        idUser: '99',
        idRoom: 10,
        remoteUserName: 'alice',
        remoteUserDeviceId: 1,
      })
    );
    expect(mockProfileRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        idUser: 99,
        idRoom: 10,
        username: 'alice',
      })
    );
  });

  // ==========================================================================
  // 7. setSession: cleans up DB if establishSession fails
  // ==========================================================================
  it('setSession cleans up DB if establishSession fails', async () => {
    (SignalProtocol.establishSession as jest.Mock).mockRejectedValueOnce(
      new Error('session error')
    );

    const result = await sessionService.setSession(10, 99, 'alice');

    expect(result).toBe(false);
    expect(mockSessionRepo.deleteByUserAndRoom).toHaveBeenCalledWith('99', 10);
    expect(mockSessionRepo.upsert).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 8. hasSession: delegates to sessionRepository.exists
  // ==========================================================================
  it('hasSession delegates to sessionRepository.exists', async () => {
    mockSessionRepo.exists.mockResolvedValue(true);

    const result = await sessionService.hasSession(10, 99);
    expect(result).toBe(true);
    expect(mockSessionRepo.exists).toHaveBeenCalledWith('99', 10);
  });

  // ==========================================================================
  // 9. resumeSession: calls SignalProtocol.resumeSession
  // ==========================================================================
  it('resumeSession calls SignalProtocol.resumeSession', async () => {
    await sessionService.resumeSession(10, '99', 'alice', 2);

    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('99', 'alice', 2);
  });

  // ==========================================================================
  // 10. resumeSession: falls back to recoverSession on failure
  // ==========================================================================
  it('resumeSession falls back to recoverSession on failure', async () => {
    (SignalProtocol.resumeSession as jest.Mock).mockRejectedValueOnce(new Error('resume error'));

    // recoverSession calls reloadRemoteKeys + establishSession
    await sessionService.resumeSession(10, '99', 'alice');

    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('99', 'alice', 1);
    // recoverSession should call setRemoteUserKeys (via reloadRemoteKeys) then establishSession
    expect(SignalProtocol.setRemoteUserKeys).toHaveBeenCalled();
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
  });

  // ==========================================================================
  // 11. ensureSession: resumes if session exists in DB
  // ==========================================================================
  it('ensureSession resumes if session exists in DB', async () => {
    mockSessionRepo.exists.mockResolvedValue(true);
    const session = makeSession({ idUser: '99', idRoom: 10 });
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(session);

    const result = await sessionService.ensureSession(10, 99);

    expect(result).toBe(true);
    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('99', 'alice', 1);
  });

  // ==========================================================================
  // 12. ensureSession: calls setSession if no session
  // ==========================================================================
  it('ensureSession calls setSession if no session exists', async () => {
    mockSessionRepo.exists.mockResolvedValue(false);
    mockSessionRepo.findByRoom.mockResolvedValue([]);

    const result = await sessionService.ensureSession(10, 99);

    // setSession success path
    expect(result).toBe(true);
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
  });

  // ==========================================================================
  // 13. ensureSessionInDatabase: creates if not existing
  // ==========================================================================
  it('ensureSessionInDatabase creates session if not existing', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(null);
    mockSessionRepo.findByRoom.mockResolvedValue([]);

    await sessionService.ensureSessionInDatabase(10, '99');

    expect(mockSessionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idUser: '99',
        idRoom: 10,
        remoteUserName: 'user-99',
        remoteUserDeviceId: 1,
        identityVerified: 0,
      })
    );
  });

  // ==========================================================================
  // 14. ensureSessionInDatabase: skips if already exists
  // ==========================================================================
  it('ensureSessionInDatabase skips if session already exists', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(makeSession());

    await sessionService.ensureSessionInDatabase(10, '99');

    expect(mockSessionRepo.create).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 15. loadSessions: resumes all unique sessions
  // ==========================================================================
  it('loadSessions resumes all unique sessions', async () => {
    const sessions = [
      makeSession({ idUser: '10', idRoom: 1 }),
      makeSession({ idUser: '10', idRoom: 2 }), // same user, different room
      makeSession({ idUser: '20', idRoom: 1 }),
    ];
    mockSessionRepo.findAll.mockResolvedValue(sessions);

    const result = await sessionService.loadSessions();

    expect(result).toHaveLength(3);
    // User '10' should be resumed only once (unique set)
    expect(SignalProtocol.resumeSession).toHaveBeenCalledTimes(2);
    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('10', 'alice', 1);
    expect(SignalProtocol.resumeSession).toHaveBeenCalledWith('20', 'alice', 1);
  });

  // ==========================================================================
  // 16. loadSessions: stores sessions per room
  // ==========================================================================
  it('loadSessions stores sessions grouped by room', async () => {
    const sessions = [
      makeSession({ idUser: '10', idRoom: 1 }),
      makeSession({ idUser: '20', idRoom: 1 }),
      makeSession({ idUser: '30', idRoom: 2 }),
    ];
    mockSessionRepo.findAll.mockResolvedValue(sessions);

    await sessionService.loadSessions();

    expect(sessionService.sessions.get(1)).toHaveLength(2);
    expect(sessionService.sessions.get(2)).toHaveLength(1);
  });

  // ==========================================================================
  // 17. recoverSession: reloads remote keys and re-establishes
  // ==========================================================================
  it('recoverSession reloads remote keys and re-establishes', async () => {
    await sessionService.recoverSession(10, '99', 'alice');

    // reloadRemoteKeys fetches remote keys and sets them via SignalProtocol
    expect(mockApi.getRemoteKeys).toHaveBeenCalledWith('99');
    expect(SignalProtocol.setRemoteUserKeys).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUserId: '99' })
    );
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
  });

  // ==========================================================================
  // 17b. recoverSession: aborts on identity key mismatch (B-03)
  // ==========================================================================
  it('recoverSession aborts and surfaces alert on identity key mismatch', async () => {
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockResolvedValueOnce({
      changed: true,
      reason: '',
    });

    await expect(sessionService.recoverSession(10, '99', 'alice')).rejects.toBeInstanceOf(
      IdentityKeyMismatchError
    );

    // Fetched keys to compare identity but MUST NOT have applied them.
    expect(mockApi.getRemoteKeys).toHaveBeenCalledWith('99');
    expect(SignalProtocol.checkIdentityKeyChanged).toHaveBeenCalledWith('99', 'idKey==');
    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
    expect(SignalProtocol.establishSession).not.toHaveBeenCalled();
    expect(mockAppState.addSecurityAlert).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 10, userId: 99, type: 'identity_key_changed' })
    );
  });

  // ==========================================================================
  // 17c. recoverSession: proceeds on TOFU when first contact (no prior session)
  // ==========================================================================
  it('recoverSession proceeds on TOFU when no prior session row exists', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(null);
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockResolvedValueOnce({
      changed: false,
      reason: 'No identity saved yet',
    });

    await expect(sessionService.recoverSession(10, '99', 'alice')).resolves.toBeUndefined();

    expect(SignalProtocol.setRemoteUserKeys).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUserId: '99', identityPublicKey: 'idKey==' })
    );
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
    expect(mockAppState.addSecurityAlert).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 17d. recoverSession: tolerates native "Session not initialized" only on
  //      first contact (no prior session row in DB)
  // ==========================================================================
  it('recoverSession proceeds when native check is unavailable AND no prior session', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(null);
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockRejectedValueOnce(
      new Error('Session for remoteUserId 99 is not initialized.')
    );

    await expect(sessionService.recoverSession(10, '99', 'alice')).resolves.toBeUndefined();

    expect(SignalProtocol.setRemoteUserKeys).toHaveBeenCalled();
    expect(SignalProtocol.establishSession).toHaveBeenCalledWith('99');
    expect(mockAppState.addSecurityAlert).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 17f. recoverSession: aborts when prior session row exists but native store
  //      has no identity (post-trust identity disappearance — suspected MITM)
  // ==========================================================================
  it('recoverSession aborts when prior session exists but native reports no identity', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(makeSession({ idUser: '99', idRoom: 10 }));
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockResolvedValueOnce({
      changed: false,
      reason: 'No identity saved yet',
    });

    await expect(sessionService.recoverSession(10, '99', 'alice')).rejects.toBeInstanceOf(
      IdentityKeyMismatchError
    );

    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
    expect(SignalProtocol.establishSession).not.toHaveBeenCalled();
    expect(mockAppState.addSecurityAlert).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 10, userId: 99, type: 'identity_key_changed' })
    );
  });

  // ==========================================================================
  // 17g. recoverSession: aborts when prior session exists but native check throws
  // ==========================================================================
  it('recoverSession aborts when prior session exists but native check throws', async () => {
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(makeSession({ idUser: '99', idRoom: 10 }));
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockRejectedValueOnce(
      new Error('Session for remoteUserId 99 is not initialized.')
    );

    await expect(sessionService.recoverSession(10, '99', 'alice')).rejects.toBeInstanceOf(
      IdentityKeyMismatchError
    );

    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
    expect(mockAppState.addSecurityAlert).toHaveBeenCalled();
  });

  // ==========================================================================
  // 17e. setSession: re-throws IdentityKeyMismatchError instead of re-creating
  // ==========================================================================
  it('setSession does not recreate the session when resume surfaces identity mismatch', async () => {
    const session = makeSession({ idUser: '99', idRoom: 10 });
    mockSessionRepo.findByUserAndRoom.mockResolvedValue(session);
    (SignalProtocol.resumeSession as jest.Mock).mockRejectedValueOnce(new Error('resume failed'));
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockResolvedValueOnce({
      changed: true,
      reason: '',
    });

    await expect(sessionService.setSession(10, 99, 'alice')).rejects.toBeInstanceOf(
      IdentityKeyMismatchError
    );

    // No fresh session was applied — old session preserved.
    expect(SignalProtocol.setRemoteUserKeys).not.toHaveBeenCalled();
    expect(mockSessionRepo.upsert).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 18. handleIdentityKeyChanged: adds security alert to store
  // ==========================================================================
  it('handleIdentityKeyChanged adds security alert to app store', () => {
    sessionService.handleIdentityKeyChanged(10, 99);

    expect(mockAppState.addSecurityAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 10,
        userId: 99,
        type: 'identity_key_changed',
      })
    );
  });

  // ==========================================================================
  // 19. checkIdentityChanged: returns false when not changed
  // ==========================================================================
  it('checkIdentityChanged returns false when identity has not changed', async () => {
    (SignalProtocol.checkIdentityKeyChanged as jest.Mock).mockResolvedValue({
      changed: false,
      reason: '',
    });

    const result = await sessionService.checkIdentityChanged(10, '99');
    expect(result).toBe(false);
    expect(SignalProtocol.checkIdentityKeyChanged).toHaveBeenCalledWith('99');
  });

  // ==========================================================================
  // 20. initializePreKeyTracking: reads bundle and sets lastPreKeyId
  // ==========================================================================
  it('initializePreKeyTracking reads bundle and sets lastPreKeyId', async () => {
    (SignalProtocol.getFullPublicBundle as jest.Mock).mockResolvedValue({
      deviceId: 3,
      preKeys: [{ id: 10 }, { id: 50 }, { id: 25 }],
      kyberPreKeys: [{ id: 5 }, { id: 80 }],
      signedPreKey: { id: 1, publicKey: 'spk==', signature: 'sig==' },
    });

    await sessionService.initializePreKeyTracking();

    expect((sessionService as any).deviceId).toBe(3);
    expect((sessionService as any).lastPreKeyId).toBe(50);
    expect((sessionService as any).lastKyberPreKeyId).toBe(80);
  });

  // ==========================================================================
  // 21. refreshPreKeysIfNeeded: skips if not authenticated
  // ==========================================================================
  it('refreshPreKeysIfNeeded skips if not authenticated', async () => {
    mockAuthState = createMockAuthStoreState({ isAuthenticated: false });

    await sessionService.refreshPreKeysIfNeeded(1);

    expect(mockApi.getKeyStatus).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 22. refreshPreKeysIfNeeded: skips if in background
  // ==========================================================================
  it('refreshPreKeysIfNeeded skips if in background', async () => {
    mockAppState = createMockAppStoreState({ isInBackground: true });

    await sessionService.refreshPreKeysIfNeeded(1);

    expect(mockApi.getKeyStatus).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 23. rotateSignedPreKeyIfNeeded: skips if within 30 days
  // ==========================================================================
  it('rotateSignedPreKeyIfNeeded skips if within 30 days', async () => {
    // Set last rotation to 1 day ago
    const oneDayAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    (sessionService as any).lastSignedPreKeyRotation = oneDayAgo;

    await sessionService.rotateSignedPreKeyIfNeeded(1);

    expect(SignalProtocol.rotateSignedPreKey).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 24. validateRemoteKeys: rejects invalid registrationId or non-base64 keys
  // ==========================================================================
  describe('validateRemoteKeys', () => {
    const callValidate = (keys: any) => {
      return (sessionService as any).validateRemoteKeys(keys);
    };

    const validKeys = {
      remoteUserId: '99',
      preKeyId: 5,
      preKeyPublicKey: 'pk==',
      signedPreKeyId: 1,
      signedPreKeyPublicKey: 'spk==',
      signedPreKeySignature: 'sig==',
      identityPublicKey: 'idKey==',
      registrationId: 1234,
      deviceId: 1,
      kyberPreKeyId: 7,
      kyberPreKeyPublicKey: 'kpk==',
      kyberPreKeySignature: 'ksig==',
    };

    it('accepts valid keys', () => {
      expect(callValidate(validKeys)).toBe(true);
    });

    it('rejects registrationId < 1', () => {
      expect(callValidate({ ...validKeys, registrationId: 0 })).toBe(false);
    });

    it('rejects registrationId > 0x3FFF', () => {
      expect(callValidate({ ...validKeys, registrationId: 0x4000 })).toBe(false);
    });

    it('rejects non-base64 identity public key', () => {
      expect(callValidate({ ...validKeys, identityPublicKey: '!!!invalid!!!' })).toBe(false);
    });

    it('rejects empty identity public key', () => {
      expect(callValidate({ ...validKeys, identityPublicKey: '' })).toBe(false);
    });

    it('rejects when required field is missing', () => {
      const { preKeyId: _, ...incomplete } = validKeys;
      expect(callValidate(incomplete)).toBe(false);
    });
  });
});
