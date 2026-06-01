// Mock for the native Signal Protocol module

// ===== MULTI-DEVICE PROVISIONING — mock helpers =====
//
// Deterministic, in-memory simulation of ECDHE+AES-GCM so tests can exercise
// the full pairing crypto without depending on the native module. Encrypt and
// decrypt are inverses only when keys are paired correctly — wrong keys raise,
// matching the real failure mode of AES-GCM tag verification.
let __provKeypairCounter = 0;
const __provKeypairs = new Map<string, string>(); // pub <-> priv

// The high-level pairing wrappers (encryptProvisioningPayload /
// consumeProvisioningPayload) on the real native modules read/write the
// identity from the Keychain. The mock uses a fixed pair so the test surface
// can assert what came through. The two fields are linked by naming
// convention: <prefix>Serialized<suffix> ↔ <prefix>Pub<suffix>. The mock's
// integrity check (consumeProvisioningPayload) verifies that pub is derivable
// from the serialized blob via this rule, matching what the real native
// module does by deserializing the IdentityKeyPair and comparing.
const MOCK_PRIMARY_IDENTITY_SERIALIZED = 'mockIdentityPrimarySerialized==';
const MOCK_PRIMARY_IDENTITY_PUB = 'mockIdentityPrimaryPub==';

const __deriveMockIdentityPub = (serialized: string): string | null => {
  if (!serialized.includes('Serialized')) return null;
  return serialized.replace(/Serialized/g, 'Pub');
};

const __resetProvisioningMock = () => {
  __provKeypairCounter = 0;
  __provKeypairs.clear();
};

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
  encryptMessage: jest.fn().mockImplementation(
    (message: string, _userId: string, _deviceId?: number | null) => {
      return Promise.resolve({ encryptedMessage: `encrypted:${message}` });
    }
  ),
  decryptMessage: jest.fn().mockImplementation((encrypted: string, _userId: string) => {
    const msg = encrypted.startsWith('encrypted:') ? encrypted.slice(10) : 'decrypted-message';
    return Promise.resolve({ message: msg });
  }),

  // Multi-device provisioning
  generateProvisioningKeypair: jest.fn().mockImplementation(() => {
    __provKeypairCounter += 1;
    const publicKey = `mockProvPub${__provKeypairCounter}==`;
    const privateKey = `mockProvPriv${__provKeypairCounter}==`;
    __provKeypairs.set(publicKey, privateKey);
    __provKeypairs.set(privateKey, publicKey);
    return Promise.resolve({ publicKey, privateKey });
  }),
  encryptProvisioning: jest.fn().mockImplementation(
    (plaintext: string, recipientPub: string, senderPriv: string) => {
      const senderPub = __provKeypairs.get(senderPriv);
      if (!senderPub) {
        return Promise.reject(new Error('mock: unknown sender private key'));
      }
      if (!__provKeypairs.has(recipientPub)) {
        return Promise.reject(new Error('mock: unknown recipient public key'));
      }
      const envelope = `mockProvCt|${senderPub}|${recipientPub}|${plaintext}`;
      const ciphertext = Buffer.from(envelope, 'utf8').toString('base64');
      return Promise.resolve({ ciphertext });
    }
  ),
  decryptProvisioning: jest.fn().mockImplementation(
    (ciphertextB64: string, recipientPriv: string, senderPub: string) => {
      const recipientPub = __provKeypairs.get(recipientPriv);
      if (!recipientPub) {
        return Promise.reject(new Error('mock: unknown recipient private key'));
      }
      let envelope: string;
      try {
        envelope = Buffer.from(ciphertextB64, 'base64').toString('utf8');
      } catch {
        return Promise.reject(new Error('mock: malformed ciphertext'));
      }
      const parts = envelope.split('|');
      if (parts.length !== 4 || parts[0] !== 'mockProvCt') {
        return Promise.reject(new Error('mock: malformed provisioning envelope'));
      }
      const [, ctSenderPub, ctRecipientPub, plaintext] = parts;
      if (ctSenderPub !== senderPub) {
        return Promise.reject(new Error('mock: sender public key mismatch (AEAD tag fail)'));
      }
      if (ctRecipientPub !== recipientPub) {
        return Promise.reject(new Error('mock: recipient public key mismatch (AEAD tag fail)'));
      }
      return Promise.resolve({ plaintext });
    }
  ),
  getPairingSafetyNumber: jest.fn().mockImplementation(
    (ephemeralPubA: string, ephemeralPubB: string, identityPub: string, primaryUserId: string) => {
      const seed = `${ephemeralPubA}|${ephemeralPubB}|${identityPub}|${primaryUserId}`;
      // Simple deterministic 60-digit projection — sufficient for cross-side equality tests.
      let acc = BigInt(0);
      for (let i = 0; i < seed.length; i += 1) {
        acc = (acc * BigInt(131) + BigInt(seed.charCodeAt(i))) % BigInt('1000000000000000000000000000000000000000000000000000000000000');
      }
      const padded = acc.toString().padStart(60, '0');
      const groups = padded.match(/.{5}/g) ?? [];
      return Promise.resolve({ safetyNumber: groups.join(' ') });
    }
  ),
  deleteRemoteSession: jest.fn().mockResolvedValue(undefined),

  // High-level pairing wrappers — Option B path. Mock builds the
  // ProvisioningPayloadV1 JSON internally and reuses the round-trip envelope
  // of encryptProvisioning/decryptProvisioning under the hood. This mirrors
  // the native implementation, where these wrappers are thin layers above
  // the same low-level ECDHE+AES-GCM helpers.
  encryptProvisioningPayload: jest.fn().mockImplementation(
    (recipientPub: string, senderPriv: string, primaryUserId: string, primaryName?: string | null) => {
      const senderPub = __provKeypairs.get(senderPriv);
      if (!senderPub) {
        return Promise.reject(new Error('mock: unknown sender private key'));
      }
      if (!__provKeypairs.has(recipientPub)) {
        return Promise.reject(new Error('mock: unknown recipient public key'));
      }
      const payload: Record<string, unknown> = {
        v: 1,
        identityKeySerialized: MOCK_PRIMARY_IDENTITY_SERIALIZED,
        identityKeyPub: MOCK_PRIMARY_IDENTITY_PUB,
        primaryUserId,
      };
      if (primaryName) payload.primaryName = primaryName;
      const plaintextB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const envelope = `mockProvCt|${senderPub}|${recipientPub}|${plaintextB64}`;
      return Promise.resolve({ ciphertext: Buffer.from(envelope, 'utf8').toString('base64') });
    }
  ),
  peekProvisioningPayload: jest.fn().mockImplementation(
    (ciphertextB64: string, recipientPriv: string, senderPub: string) => {
      const recipientPub = __provKeypairs.get(recipientPriv);
      if (!recipientPub) {
        return Promise.reject(new Error('mock: unknown recipient private key'));
      }
      let envelope: string;
      try {
        envelope = Buffer.from(ciphertextB64, 'base64').toString('utf8');
      } catch {
        return Promise.reject(new Error('mock: malformed ciphertext'));
      }
      const parts = envelope.split('|');
      if (parts.length !== 4 || parts[0] !== 'mockProvCt') {
        return Promise.reject(new Error('mock: malformed provisioning envelope'));
      }
      const [, ctSenderPub, ctRecipientPub, plaintextB64] = parts;
      if (ctSenderPub !== senderPub) {
        return Promise.reject(new Error('mock: sender public key mismatch (AEAD tag fail)'));
      }
      if (ctRecipientPub !== recipientPub) {
        return Promise.reject(new Error('mock: recipient public key mismatch (AEAD tag fail)'));
      }
      let parsed: { v?: number; identityKeySerialized?: string; identityKeyPub?: string; primaryUserId?: string; primaryName?: string };
      try {
        parsed = JSON.parse(Buffer.from(plaintextB64, 'base64').toString('utf8'));
      } catch {
        return Promise.reject(new Error('mock: provisioning payload is not valid JSON'));
      }
      if (parsed.v !== 1) {
        return Promise.reject(new Error('mock: unsupported provisioning payload version'));
      }
      if (!parsed.identityKeySerialized || !parsed.identityKeyPub || !parsed.primaryUserId) {
        return Promise.reject(new Error('mock: provisioning payload missing required fields'));
      }
      const derivedPub = __deriveMockIdentityPub(parsed.identityKeySerialized);
      if (derivedPub !== parsed.identityKeyPub) {
        return Promise.reject(new Error('mock: integrity check failed (identityKeyPub does not match identityKeySerialized)'));
      }
      const result: Record<string, unknown> = {
        primaryUserId: parsed.primaryUserId,
        identityKeyPub: parsed.identityKeyPub,
      };
      if (parsed.primaryName) result.primaryName = parsed.primaryName;
      return Promise.resolve(result);
    }
  ),
  consumeProvisioningPayload: jest.fn().mockImplementation(
    (ciphertextB64: string, recipientPriv: string, senderPub: string, deviceId: number, _name: string) => {
      const recipientPub = __provKeypairs.get(recipientPriv);
      if (!recipientPub) {
        return Promise.reject(new Error('mock: unknown recipient private key'));
      }
      let envelope: string;
      try {
        envelope = Buffer.from(ciphertextB64, 'base64').toString('utf8');
      } catch {
        return Promise.reject(new Error('mock: malformed ciphertext'));
      }
      const parts = envelope.split('|');
      if (parts.length !== 4 || parts[0] !== 'mockProvCt') {
        return Promise.reject(new Error('mock: malformed provisioning envelope'));
      }
      const [, ctSenderPub, ctRecipientPub, plaintextB64] = parts;
      if (ctSenderPub !== senderPub) {
        return Promise.reject(new Error('mock: sender public key mismatch (AEAD tag fail)'));
      }
      if (ctRecipientPub !== recipientPub) {
        return Promise.reject(new Error('mock: recipient public key mismatch (AEAD tag fail)'));
      }
      let parsed: { v?: number; identityKeySerialized?: string; identityKeyPub?: string };
      try {
        parsed = JSON.parse(Buffer.from(plaintextB64, 'base64').toString('utf8'));
      } catch {
        return Promise.reject(new Error('mock: provisioning payload is not valid JSON'));
      }
      if (parsed.v !== 1) {
        return Promise.reject(new Error('mock: unsupported provisioning payload version'));
      }
      if (!parsed.identityKeySerialized || !parsed.identityKeyPub) {
        return Promise.reject(new Error('mock: provisioning payload missing required fields'));
      }
      const derivedPub = __deriveMockIdentityPub(parsed.identityKeySerialized);
      if (derivedPub !== parsed.identityKeyPub) {
        return Promise.reject(new Error('mock: integrity check failed (identityKeyPub does not match identityKeySerialized)'));
      }
      // Successful import: return a deterministic public bundle, identical
      // in shape to what initializeIdentity returns.
      return Promise.resolve({
        identityPublicKey: parsed.identityKeyPub,
        registrationId: 1234,
        deviceId,
        signedPreKey: { id: 1, publicKey: 'mockSignedPreKey==', signature: 'mockSignature==' },
        preKeys: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, publicKey: `preKey${i}==` })),
        kyberPreKeys: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, publicKey: `kyberKey${i}==`, signature: `kyberSig${i}==` })),
      });
    }
  ),

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
  // ADR-0010: per-device server-auth credential
  getDeviceAuthPublicKey: jest.fn().mockResolvedValue({ publicKey: 'mockDeviceAuthPub==' }),
  signWithDeviceAuth: jest.fn().mockResolvedValue({ signature: 'mockDeviceAuthSig==' }),

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
export { SignalProtocol, __resetProvisioningMock, MOCK_PRIMARY_IDENTITY_SERIALIZED, MOCK_PRIMARY_IDENTITY_PUB };
