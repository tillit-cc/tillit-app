// Mocks must be declared before importing the store (which resolves these
// at module load). signal-protocol + expo-secure-store auto-mock via the
// jest.config moduleNameMapper.
const mockApi = {
  baseUrl: 'https://api.test.com',
  requestChallenge: jest.fn(),
  authenticateWithIdentity: jest.fn(),
  recoverPrimaryAuthKey: jest.fn().mockResolvedValue(undefined),
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

describe('auth.store — recoverPrimaryAuth (ADR-0010 primary recovery)', () => {
  const SignalProtocol = require('signal-protocol').default;

  beforeEach(() => {
    jest.clearAllMocks();
    (SignalProtocol.getPublicIdentity as jest.Mock).mockResolvedValue({
      identityPublicKey: 'mockIdentityPublicKey==',
      registrationId: 1234,
      deviceId: 1,
    });
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

  it('runs the 3-step flow: recovery login (no device-auth sig) → re-bind → normal re-login', async () => {
    await useAuthStore.getState().recoverPrimaryAuth();

    // Two /auth/identity calls: step 1 (recovery) and step 3 (normal re-login).
    expect(mockApi.authenticateWithIdentity).toHaveBeenCalledTimes(2);

    const step1 = mockApi.authenticateWithIdentity.mock.calls[0][0];
    expect(step1.recoverPrimary).toBe(true);
    expect(step1.deviceAuthSignature).toBeUndefined();

    // Step 2: re-bind the new device-auth public key.
    expect(mockApi.recoverPrimaryAuthKey).toHaveBeenCalledTimes(1);
    expect(mockApi.recoverPrimaryAuthKey).toHaveBeenCalledWith('mockDeviceAuthPub==');

    const step3 = mockApi.authenticateWithIdentity.mock.calls[1][0];
    expect(step3.recoverPrimary).toBeUndefined();
    expect(step3.deviceAuthSignature).toBe('mockDeviceAuthSig==');
  });

  it('falls back to a normal login when the server says PRIMARY_RECOVERY_NOT_NEEDED', async () => {
    mockApi.authenticateWithIdentity
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'PRIMARY_RECOVERY_NOT_NEEDED' } } })
      .mockResolvedValueOnce({ accessToken: 'h.p.s', userId: 42, isNewUser: false });

    await useAuthStore.getState().recoverPrimaryAuth();

    // No re-bind attempted; fell through to a normal login (2nd identity call).
    expect(mockApi.recoverPrimaryAuthKey).not.toHaveBeenCalled();
    expect(mockApi.authenticateWithIdentity).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('refuses to run on a non-primary (linked) device', async () => {
    (SignalProtocol.getPublicIdentity as jest.Mock).mockResolvedValue({
      identityPublicKey: 'mockIdentityPublicKey==',
      registrationId: 1234,
      deviceId: 2,
    });

    await expect(useAuthStore.getState().recoverPrimaryAuth()).rejects.toThrow();
    expect(mockApi.recoverPrimaryAuthKey).not.toHaveBeenCalled();
  });
});
