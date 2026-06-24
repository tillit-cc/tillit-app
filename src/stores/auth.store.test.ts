// Mocks must be declared before importing the store (which resolves these
// at module load). signal-protocol + expo-secure-store auto-mock via the
// jest.config moduleNameMapper.
const mockApi = {
  baseUrl: 'https://api.test.com',
  requestChallenge: jest.fn(),
  authenticateWithIdentity: jest.fn(),
  setToken: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@/services/auth-api-bridge', () => ({
  getDefaultApi: () => mockApi,
  getDefaultServerToken: jest.fn().mockResolvedValue(null),
  clearDefaultServerToken: jest.fn().mockResolvedValue(undefined),
  getDefaultServerId: () => 1,
}));

jest.mock('@/stores/server.store', () => ({
  useServerStore: { getState: () => ({ setBanned: jest.fn() }) },
}));

import SignalProtocol from 'signal-protocol';
import { useAuthStore } from './auth.store';

describe('auth.store — authenticateWithBackend (ADR-0010 device-auth)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A valid-ish base64 nonce so buildChallengeMessageBase64 (real util) runs.
    mockApi.requestChallenge.mockResolvedValue({
      challengeId: 'challenge-1',
      nonce: Buffer.from('test-nonce-bytes').toString('base64'),
    });
    mockApi.authenticateWithIdentity.mockResolvedValue({
      accessToken: 'header.payload.sig',
      userId: 42,
      isNewUser: false,
    });
  });

  it('signs the challenge with BOTH identity and device-auth keys, over the same message', async () => {
    await useAuthStore.getState().authenticateWithBackend();

    expect(SignalProtocol.signWithIdentityKey).toHaveBeenCalledTimes(1);
    expect(SignalProtocol.signWithDeviceAuth).toHaveBeenCalledTimes(1);

    const identityArg = (SignalProtocol.signWithIdentityKey as jest.Mock).mock.calls[0][0];
    const deviceAuthArg = (SignalProtocol.signWithDeviceAuth as jest.Mock).mock.calls[0][0];
    // Same domain-separated challenge message feeds both signatures.
    expect(deviceAuthArg).toBe(identityArg);
  });

  it('forwards deviceAuthSignature alongside challengeSignature to /auth/identity', async () => {
    await useAuthStore.getState().authenticateWithBackend();

    expect(mockApi.authenticateWithIdentity).toHaveBeenCalledTimes(1);
    const payload = mockApi.authenticateWithIdentity.mock.calls[0][0];
    expect(payload.challengeSignature).toBe('mockSignature==');
    expect(payload.deviceAuthSignature).toBe('mockDeviceAuthSig==');
  });

  it('authenticates successfully and stores the resolved userId', async () => {
    await useAuthStore.getState().authenticateWithBackend();
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userId).toBe(42);
  });
});
