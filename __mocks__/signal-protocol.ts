// Mock for the native Signal Protocol module
const SignalProtocol = {
  // Identity
  initializeIdentity: jest.fn().mockResolvedValue({
    identityPublicKey: 'mockIdentityPublicKey==',
    registrationId: 1234,
    deviceId: 1,
    signedPreKey: { id: 1, publicKey: 'mockSignedPreKey==', signature: 'mockSignature==' },
    preKeys: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, publicKey: `preKey${i}==` })),
    kyberPreKeys: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, publicKey: `kyberKey${i}==`, signature: `kyberSig${i}==` })),
  }),
  getPublicIdentity: jest.fn().mockResolvedValue({
    identityPublicKey: 'mockIdentityPublicKey==',
    registrationId: 1234,
    deviceId: 1,
  }),
  getSignedPreKeyInfo: jest.fn().mockResolvedValue({
    id: 1,
    publicKey: 'mockSignedPreKey==',
    signature: 'mockSignature==',
  }),
  getFullPublicBundle: jest.fn().mockResolvedValue({
    identityPublicKey: 'mockIdentityPublicKey==',
    registrationId: 1234,
    deviceId: 1,
    signedPreKey: { id: 1, publicKey: 'mockSignedPreKey==', signature: 'mockSignature==' },
    preKeys: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, publicKey: `preKey${i}==` })),
    kyberPreKeys: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, publicKey: `kyberKey${i}==`, signature: `kyberSig${i}==` })),
  }),
  clearIdentity: jest.fn().mockResolvedValue(undefined),

  // Key rotation
  replenishPreKeys: jest.fn().mockResolvedValue({
    preKeys: Array.from({ length: 50 }, (_, i) => ({ id: i + 100, publicKey: `newPreKey${i}==` })),
  }),
  replenishKyberPreKeys: jest.fn().mockResolvedValue({
    kyberPreKeys: Array.from({ length: 50 }, (_, i) => ({ id: i + 100, publicKey: `newKyberKey${i}==`, signature: `newKyberSig${i}==` })),
  }),
  rotateSignedPreKey: jest.fn().mockResolvedValue({
    id: 2,
    publicKey: 'newSignedPreKey==',
    signature: 'newSignedPreKeySignature==',
  }),

  // Session management
  setLocalUserId: jest.fn().mockResolvedValue({ success: true }),
  setRemoteUserKeys: jest.fn().mockResolvedValue(undefined),
  establishSession: jest.fn().mockResolvedValue({ success: true }),
  resumeSession: jest.fn().mockResolvedValue({ success: true }),

  // Encryption/Decryption
  encryptMessage: jest.fn().mockImplementation((message: string, _userId: string) => {
    return Promise.resolve({ encryptedMessage: `encrypted:${message}` });
  }),
  decryptMessage: jest.fn().mockImplementation((encrypted: string, _userId: string) => {
    const msg = encrypted.startsWith('encrypted:') ? encrypted.slice(10) : 'decrypted-message';
    return Promise.resolve({ message: msg });
  }),

  // Identity verification
  getSafetyNumber: jest.fn().mockResolvedValue({ safetyNumber: '12345 67890 12345 67890' }),
  verifyIdentity: jest.fn().mockResolvedValue({ success: true }),
  checkIdentityKeyChanged: jest.fn().mockResolvedValue({ changed: false, reason: '' }),

  // Sender keys
  createSenderKeySession: jest.fn().mockResolvedValue({
    distributionMessage: 'mockDistributionMessage',
    success: true,
  }),
  processSenderKeyDistribution: jest.fn().mockImplementation((_roomId: string, _senderId: string, _msg: string, _senderDeviceId?: number | null) => {
    return Promise.resolve(undefined);
  }),
  encryptGroupMessage: jest.fn().mockImplementation((message: string, _roomId: string, _distId: string) => {
    return Promise.resolve({ ciphertext: `group-encrypted:${message}` });
  }),
  decryptGroupMessage: jest.fn().mockImplementation((ciphertext: string, _roomId: string, _senderId: string, _senderDeviceId?: number | null) => {
    const msg = ciphertext.startsWith('group-encrypted:') ? ciphertext.slice(16) : 'group-decrypted';
    return Promise.resolve({ message: msg });
  }),
  rotateSenderKey: jest.fn().mockResolvedValue({
    distributionMessage: 'mockRotatedDistributionMessage',
    success: true,
  }),
  deleteSenderKeySession: jest.fn().mockResolvedValue(undefined),

  // Auth
  signWithIdentityKey: jest.fn().mockResolvedValue({ signature: 'mockSignature==' }),

  // Biometric
  authenticate: jest.fn().mockResolvedValue({ authenticated: true }),
  isAuthenticated: jest.fn().mockReturnValue({ authenticated: true }),
  lock: jest.fn(),
  extendAuthentication: jest.fn().mockReturnValue({ success: true }),
  checkDeviceSecurity: jest.fn().mockReturnValue({ isSecure: true }),
  hasStoredIdentity: jest.fn().mockReturnValue({ hasStoredIdentity: false }),
  loadStoredLocalUser: jest.fn().mockResolvedValue({ success: true }),

  // AES
  encryptAESGCM: jest.fn().mockResolvedValue({
    encryptedBase64: 'mockEncryptedBase64==',
    keyBase64: 'mockKeyBase64==',
    ivBase64: 'mockIvBase64==',
  }),
  decryptAESGCM: jest.fn().mockResolvedValue('mockDecryptedBase64=='),

  // Hardware-protected generic storage
  setProtectedData: jest.fn().mockResolvedValue({ success: true }),
  getProtectedData: jest.fn().mockResolvedValue({ data: null }),
  deleteProtectedData: jest.fn().mockResolvedValue({ success: true }),
};

export default SignalProtocol;
export { SignalProtocol };
