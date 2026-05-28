import { NativeModule, requireNativeModule } from 'expo-modules-core';
import type {
  PublicKeyBundle,
  PublicIdentity,
  SignedPreKeyInfo,
  PublicPreKey,
  PublicKyberPreKey,
  RemoteUserKeys,
  AuthResult,
  EncryptResult,
  DecryptResult,
  SessionResult,
  SignatureResult,
  SafetyNumberResult,
  IdentityCheckResult,
  SenderKeyResult,
  GroupEncryptResult,
  ExistingIdentityKey,
  ProvisioningKeypair,
  EncryptProvisioningResult,
  DecryptProvisioningResult,
  PairingSafetyNumberResult,
  PeekProvisioningResult,
} from './SignalProtocol.types';

// Re-export types
export * from './SignalProtocol.types';

// Native module interface - matches Swift AsyncFunction/Function signatures
interface SignalProtocolModuleInterface extends NativeModule {
  // ===== IDENTITY INITIALIZATION =====
  initializeIdentity(
    deviceId: number,
    name: string,
    existingIdentityKey?: ExistingIdentityKey | null
  ): Promise<PublicKeyBundle>;
  getPublicIdentity(): Promise<PublicIdentity>;
  getSignedPreKeyInfo(): Promise<SignedPreKeyInfo>;
  getFullPublicBundle(): Promise<PublicKeyBundle>;
  clearIdentity(): Promise<void>;

  // ===== KEY ROTATION =====
  replenishPreKeys(startId: number, count: number): Promise<{ preKeys: PublicPreKey[] }>;
  replenishKyberPreKeys(startId: number, count: number): Promise<{ kyberPreKeys: PublicKyberPreKey[] }>;
  rotateSignedPreKey(): Promise<SignedPreKeyInfo>;

  // ===== SESSION MANAGEMENT =====
  setLocalUserId(userId: string): Promise<{ success: boolean }>;
  setRemoteUserKeys(params: RemoteUserKeys): Promise<void>;
  establishSession(
    remoteUserId: string,
    remoteDeviceId?: number | null
  ): Promise<SessionResult>;
  resumeSession(
    remoteUserId: string,
    remoteUserName: string,
    remoteUserDeviceId: number
  ): Promise<SessionResult>;

  // ===== ENCRYPTION/DECRYPTION =====
  encryptMessage(
    message: string,
    remoteUserId: string,
    remoteDeviceId?: number | null
  ): Promise<EncryptResult>;
  decryptMessage(encryptedMessage: string, remoteUserId: string, deviceId?: number | null): Promise<DecryptResult>;

  // ===== MULTI-DEVICE PROVISIONING =====
  // See _shared/api/multi-device-linking.md for the full protocol.
  generateProvisioningKeypair(): Promise<ProvisioningKeypair>;
  encryptProvisioning(
    plaintextBase64: string,
    recipientPublicKey: string,
    senderPrivateKey: string
  ): Promise<EncryptProvisioningResult>;
  decryptProvisioning(
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string
  ): Promise<DecryptProvisioningResult>;
  getPairingSafetyNumber(
    ephemeralPubA: string,
    ephemeralPubB: string,
    identityPub: string,
    primaryUserId: string
  ): Promise<PairingSafetyNumberResult>;

  // ===== MULTI-DEVICE PROVISIONING — HIGH-LEVEL WRAPPERS =====
  // Production path used by the pairing UI. The identity private key NEVER
  // crosses the JS boundary: encryptProvisioningPayload reads it from the
  // Keychain inside native code; consumeProvisioningPayload decrypts and
  // installs it into the Keychain inside native code, returning only the
  // device-fresh public bundle. The low-level encryptProvisioning/
  // decryptProvisioning helpers remain available for tests and edge cases.
  encryptProvisioningPayload(
    recipientPublicKey: string,
    senderPrivateKey: string,
    primaryUserId: string,
    primaryName?: string | null
  ): Promise<EncryptProvisioningResult>;
  peekProvisioningPayload(
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string
  ): Promise<PeekProvisioningResult>;
  consumeProvisioningPayload(
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string,
    deviceId: number,
    name: string
  ): Promise<PublicKeyBundle>;

  // ===== REMOTE SESSION MANAGEMENT (multi-device revocation) =====
  deleteRemoteSession(
    remoteUserId: string,
    remoteDeviceId?: number | null
  ): Promise<void>;

  // ===== IDENTITY VERIFICATION =====
  getSafetyNumber(remoteUserId: string): Promise<SafetyNumberResult>;
  verifyIdentity(remoteUserId: string): Promise<SessionResult>;
  checkIdentityKeyChanged(
    remoteUserId: string,
    identityKey?: string
  ): Promise<IdentityCheckResult>;

  // ===== SENDER KEYS (GROUP ENCRYPTION) =====
  createSenderKeySession(roomId: string, distributionId: string): Promise<SenderKeyResult>;
  processSenderKeyDistribution(
    roomId: string,
    senderId: string,
    distributionMessage: string,
    senderDeviceId?: number | null
  ): Promise<void>;
  encryptGroupMessage(
    message: string,
    roomId: string,
    distributionId: string
  ): Promise<GroupEncryptResult>;
  decryptGroupMessage(
    ciphertext: string,
    roomId: string,
    senderId: string,
    senderDeviceId?: number | null
  ): Promise<DecryptResult>;
  rotateSenderKey(roomId: string): Promise<SenderKeyResult>;
  deleteSenderKeySession(roomId: string): Promise<void>;

  // ===== AUTHENTICATION =====
  signWithIdentityKey(data: string): Promise<SignatureResult>;

  // ===== BIOMETRIC/PASSCODE AUTHENTICATION =====
  authenticate(reason?: string): Promise<AuthResult>;
  isAuthenticated(): { authenticated: boolean };
  lock(): void;
  extendAuthentication(): { success: boolean };
  checkDeviceSecurity(): { isSecure: boolean };
  hasStoredIdentity(): { hasStoredIdentity: boolean };
  loadStoredLocalUser(): Promise<{ success: boolean }>;

  // ===== AES-256-GCM MEDIA ENCRYPTION =====
  encryptAESGCM(base64Data: string): Promise<{ encryptedBase64: string; keyBase64: string; ivBase64: string }>;
  decryptAESGCM(encryptedBase64: string, keyBase64: string, ivBase64: string): Promise<string>;

  // ===== HARDWARE-PROTECTED GENERIC STORAGE =====
  setProtectedData(key: string, dataBase64: string): Promise<{ success: boolean }>;
  getProtectedData(key: string): Promise<{ data: string | null }>;
  deleteProtectedData(key: string): Promise<{ success: boolean }>;
}

// Require the native module
const SignalProtocolModule = requireNativeModule<SignalProtocolModuleInterface>('SignalProtocol');

// Export the module with wrapped methods for better DX
export const SignalProtocol = {
  // ===== IDENTITY INITIALIZATION =====

  /**
   * Generate a new identity (or import an existing one), save private keys
   * in protected Keychain, and return ONLY the public keys for server upload.
   *
   * When `existingIdentityKey` is provided, the module imports the given
   * X25519 identity keypair instead of generating a fresh one. This is the
   * code path used by a newly linked device during multi-device pairing
   * (see _shared/api/multi-device-linking.md). All other keys (signed
   * pre-key, pre-keys, kyber pre-keys, registration id) are generated
   * fresh on this device regardless.
   *
   * MUST call authenticate() BEFORE this method to access protected Keychain.
   */
  initializeIdentity: (
    deviceId: number,
    name: string,
    existingIdentityKey?: ExistingIdentityKey | null
  ) =>
    SignalProtocolModule.initializeIdentity(deviceId, name, existingIdentityKey ?? null),

  /**
   * Get public identity data (for backend authentication).
   */
  getPublicIdentity: () => SignalProtocolModule.getPublicIdentity(),

  /**
   * Get current signed pre-key info (for backend sync).
   */
  getSignedPreKeyInfo: () => SignalProtocolModule.getSignedPreKeyInfo(),

  /**
   * Get full public bundle (for server upload after login).
   */
  getFullPublicBundle: () => SignalProtocolModule.getFullPublicBundle(),

  /**
   * Clear all identity data from Keychain.
   */
  clearIdentity: () => SignalProtocolModule.clearIdentity(),

  // ===== KEY ROTATION =====

  /**
   * Generate new one-time pre-keys, save internally, return ONLY public keys.
   */
  replenishPreKeys: (startId: number, count: number) =>
    SignalProtocolModule.replenishPreKeys(startId, count),

  /**
   * Generate new Kyber pre-keys, save internally, return ONLY public keys.
   */
  replenishKyberPreKeys: (startId: number, count: number) =>
    SignalProtocolModule.replenishKyberPreKeys(startId, count),

  /**
   * Rotate the signed pre-key, save internally, return ONLY public key.
   */
  rotateSignedPreKey: () => SignalProtocolModule.rotateSignedPreKey(),

  // ===== SESSION MANAGEMENT =====

  /**
   * Update the local user's userId after backend authentication.
   */
  setLocalUserId: (userId: string) =>
    SignalProtocolModule.setLocalUserId(userId),

  /**
   * Set remote user's public keys for session establishment.
   * This is the only method that takes an object param (native expects [String: Any]).
   */
  setRemoteUserKeys: (keys: RemoteUserKeys) =>
    SignalProtocolModule.setRemoteUserKeys(keys),

  /**
   * Establish a session with a remote user (after setRemoteUserKeys).
   *
   * `remoteDeviceId` selects which session slot to verify — libsignal's store
   * is indexed by `(remoteUserId, deviceId)`. Defaults to 1 if omitted, for
   * backward-compat with single-device peers. Multi-device callers MUST pass
   * the same deviceId they used in the preceding `setRemoteUserKeys` call,
   * otherwise the existence check looks at the wrong slot and rejects with
   * "Session not initialized" even when a valid session was just stored.
   */
  establishSession: (remoteUserId: string, remoteDeviceId?: number | null) =>
    SignalProtocolModule.establishSession(remoteUserId, remoteDeviceId ?? null),

  /**
   * Resume an existing session with a remote user.
   */
  resumeSession: (remoteUserId: string, remoteUserName: string, remoteUserDeviceId: number) =>
    SignalProtocolModule.resumeSession(remoteUserId, remoteUserName, remoteUserDeviceId),

  // ===== ENCRYPTION/DECRYPTION =====

  /**
   * Encrypt a message for a remote user.
   *
   * `remoteDeviceId` selects which device of the peer to encrypt for
   * (libsignal store is indexed by `(remoteUserId, deviceId)`). Defaults to
   * 1 if omitted, for backward-compat with single-device peers. In a
   * multi-device fan-out, the caller iterates over the peer's device list
   * and invokes this method once per `(userId, deviceId)`.
   */
  encryptMessage: (
    message: string,
    remoteUserId: string,
    remoteDeviceId?: number | null
  ) =>
    SignalProtocolModule.encryptMessage(message, remoteUserId, remoteDeviceId ?? null),

  /**
   * Decrypt a message from a remote user.
   */
  decryptMessage: (encryptedMessage: string, remoteUserId: string, deviceId?: number | null) =>
    SignalProtocolModule.decryptMessage(encryptedMessage, remoteUserId, deviceId ?? null),

  // ===== MULTI-DEVICE PROVISIONING =====
  //
  // Crypto helpers used during the multi-device pairing flow. See
  // _shared/api/multi-device-linking.md for the wire contract and
  // _shared/decisions/0001-multi-device-architecture.md (ADR-0001) for
  // the architectural rationale.

  /**
   * Generate a fresh X25519 ephemeral keypair for use in a single pairing
   * exchange. Both the primary and the new device generate one of these
   * during the pairing flow; the keypair MUST NOT be reused for any other
   * purpose. Keys are returned base64-encoded — the private key is NOT
   * persisted natively, the caller is responsible for keeping it in memory
   * for the duration of the pairing and discarding it afterwards.
   */
  generateProvisioningKeypair: () =>
    SignalProtocolModule.generateProvisioningKeypair(),

  /**
   * Encrypt the provisioning payload (the primary's identity private key
   * plus minimal metadata) for the new device.
   *
   * Derives the AES-256-GCM key from `HKDF-SHA256(X25519(senderPrivateKey,
   * recipientPublicKey), salt=∅, info="tillit/provisioning/v1", L=32)`.
   * AAD is the constant string `"tillit/provisioning/v1"`. The returned
   * ciphertext is base64 of the binary layout
   * `[1B version=0x01][12B IV][N B ct][16B GCM tag]`.
   *
   * Both inputs are base64. `plaintextBase64` is the UTF-8 bytes of the
   * JSON-stringified `ProvisioningPayloadV1` (see spec).
   */
  encryptProvisioning: (
    plaintextBase64: string,
    recipientPublicKey: string,
    senderPrivateKey: string
  ) =>
    SignalProtocolModule.encryptProvisioning(
      plaintextBase64,
      recipientPublicKey,
      senderPrivateKey
    ),

  /**
   * Reverse of `encryptProvisioning`. Used by the new device to recover the
   * primary's identity private key after polling
   * `GET /auth/devices/link/result/:token`.
   */
  decryptProvisioning: (
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string
  ) =>
    SignalProtocolModule.decryptProvisioning(
      ciphertextBase64,
      recipientPrivateKey,
      senderPublicKey
    ),

  /**
   * Compute the out-of-band safety number for a pairing transcript. Both
   * devices compute this independently and the user verifies that the two
   * strings match across screens — mitigates a MITM at the server layer
   * that swaps `ephemeralPubA`/`ephemeralPubB`.
   *
   * All key inputs are base64-encoded raw 32-byte X25519 public keys.
   * `primaryUserId` is bound into the HKDF info to prevent replay of one
   * transcript across different identities.
   */
  getPairingSafetyNumber: (
    ephemeralPubA: string,
    ephemeralPubB: string,
    identityPub: string,
    primaryUserId: string
  ) =>
    SignalProtocolModule.getPairingSafetyNumber(
      ephemeralPubA,
      ephemeralPubB,
      identityPub,
      primaryUserId
    ),

  // ===== MULTI-DEVICE PROVISIONING — HIGH-LEVEL WRAPPERS =====
  //
  // These two methods are the production code path used by the pairing UI.
  // Unlike the low-level encryptProvisioning/decryptProvisioning primitives
  // (which require the JS caller to hand in the plaintext containing the
  // identity private key), these wrappers keep the identity private key
  // confined to native code:
  //
  //   - `encryptProvisioningPayload`: primary side. Reads its own identity
  //     keypair from the Keychain, assembles the ProvisioningPayloadV1
  //     plaintext internally, performs ECDHE + HKDF + AES-256-GCM, returns
  //     only the ciphertext.
  //
  //   - `consumeProvisioningPayload`: new-device side. Performs the inverse
  //     decrypt, validates the embedded identityKeyPub against the
  //     deserialized IdentityKeyPair (mismatch → throw), and installs the
  //     imported identity into the Keychain. Returns the freshly generated
  //     public bundle for upload, never the private material.
  //
  // This matches the TilliT "protection" principle: secret material must
  // never live in JS memory, where it could be observed by debugger hooks
  // or survive in the GC.

  /**
   * Primary side: produce the encrypted provisioning payload to hand to a
   * pending new device. Requires the user to be authenticated.
   *
   * @param recipientPublicKey base64 of the new device's ephemeral X25519 public key
   * @param senderPrivateKey   base64 of the primary's ephemeral X25519 private key (fresh per pairing — never the identity priv)
   * @param primaryUserId      bound into the plaintext so the new device can verify
   * @param primaryName        optional display name for the linked device record
   */
  encryptProvisioningPayload: (
    recipientPublicKey: string,
    senderPrivateKey: string,
    primaryUserId: string,
    primaryName?: string | null
  ) =>
    SignalProtocolModule.encryptProvisioningPayload(
      recipientPublicKey,
      senderPrivateKey,
      primaryUserId,
      primaryName ?? null
    ),

  /**
   * New-device side: decrypt the provisioning payload, run the integrity
   * check (identityKeyPub must match the deserialized IdentityKeyPair), and
   * return ONLY the public fields the UI needs to compute and display the
   * pairing safety number. The decrypted identity private key is read and
   * discarded inside native code without being persisted or returned.
   *
   * Call this BEFORE `consumeProvisioningPayload`: only after the user has
   * visually confirmed that the safety number matches on both screens do
   * we commit the import via `consumeProvisioningPayload`. This split
   * preserves the "trust-no-server" guarantee — a malicious server that
   * swaps E_pub or P_pub during the pairing is caught at the safety-number
   * comparison, BEFORE any persistent state changes on the new device.
   */
  peekProvisioningPayload: (
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string
  ) =>
    SignalProtocolModule.peekProvisioningPayload(
      ciphertextBase64,
      recipientPrivateKey,
      senderPublicKey
    ),

  /**
   * New-device side: decrypt the provisioning payload produced by the
   * primary, install the imported identity into the Keychain, generate
   * fresh per-device keys (signed pre-key, pre-keys, kyber pre-keys,
   * registrationId), and return the public bundle for server upload.
   * Requires the user to be authenticated.
   *
   * Should be called only AFTER `peekProvisioningPayload` returned and
   * the user confirmed the safety number — see that method's docs.
   */
  consumeProvisioningPayload: (
    ciphertextBase64: string,
    recipientPrivateKey: string,
    senderPublicKey: string,
    deviceId: number,
    name: string
  ) =>
    SignalProtocolModule.consumeProvisioningPayload(
      ciphertextBase64,
      recipientPrivateKey,
      senderPublicKey,
      deviceId,
      name
    ),

  // ===== REMOTE SESSION MANAGEMENT (multi-device revocation) =====

  /**
   * Remove the libsignal session record for `(remoteUserId, remoteDeviceId)`.
   * Invoked when a peer revokes one of its devices (socket event
   * `deviceRevoked` with `self: false`). Subsequent `encryptMessage` calls
   * targeting the same `(userId, deviceId)` will fail until the peer
   * re-publishes a bundle.
   *
   * Defaults to deviceId=1 if omitted, matching the single-device legacy
   * behavior. Pass an explicit deviceId for multi-device peers.
   */
  deleteRemoteSession: (
    remoteUserId: string,
    remoteDeviceId?: number | null
  ) =>
    SignalProtocolModule.deleteRemoteSession(remoteUserId, remoteDeviceId ?? null),

  // ===== IDENTITY VERIFICATION =====

  /**
   * Get the safety number for out-of-band verification.
   */
  getSafetyNumber: (remoteUserId: string) =>
    SignalProtocolModule.getSafetyNumber(remoteUserId),

  /**
   * Mark a remote user's identity as manually verified.
   */
  verifyIdentity: (remoteUserId: string) =>
    SignalProtocolModule.verifyIdentity(remoteUserId),

  /**
   * Check if a remote user's identity key has changed.
   */
  checkIdentityKeyChanged: (remoteUserId: string, identityKey?: string) =>
    SignalProtocolModule.checkIdentityKeyChanged(remoteUserId, identityKey),

  // ===== SENDER KEYS (GROUP ENCRYPTION) =====

  /**
   * Create or update a sender key session for a group/room.
   */
  createSenderKeySession: (roomId: string, distributionId: string) =>
    SignalProtocolModule.createSenderKeySession(roomId, distributionId),

  /**
   * Process a sender key distribution message from a group member.
   * `senderDeviceId` defaults to 1 if omitted (single-device backward compat).
   */
  processSenderKeyDistribution: (
    roomId: string,
    senderId: string,
    distributionMessage: string,
    senderDeviceId?: number | null
  ) =>
    SignalProtocolModule.processSenderKeyDistribution(
      roomId,
      senderId,
      distributionMessage,
      senderDeviceId ?? null
    ),

  /**
   * Encrypt a message using the sender key for a group.
   */
  encryptGroupMessage: (message: string, roomId: string, distributionId: string) =>
    SignalProtocolModule.encryptGroupMessage(message, roomId, distributionId),

  /**
   * Decrypt a message from a group member.
   * `senderDeviceId` defaults to 1 if omitted (single-device backward compat).
   */
  decryptGroupMessage: (
    ciphertext: string,
    roomId: string,
    senderId: string,
    senderDeviceId?: number | null
  ) =>
    SignalProtocolModule.decryptGroupMessage(
      ciphertext,
      roomId,
      senderId,
      senderDeviceId ?? null
    ),

  /**
   * Rotate the sender key for a group.
   */
  rotateSenderKey: (roomId: string) =>
    SignalProtocolModule.rotateSenderKey(roomId),

  /**
   * Delete sender key session for a room.
   */
  deleteSenderKeySession: (roomId: string) =>
    SignalProtocolModule.deleteSenderKeySession(roomId),

  // ===== AUTHENTICATION =====

  /**
   * Sign data with the identity private key (for challenge-response auth).
   */
  signWithIdentityKey: (data: string) =>
    SignalProtocolModule.signWithIdentityKey(data),

  // ===== BIOMETRIC/PASSCODE AUTHENTICATION =====

  /**
   * Authenticate the user using Face ID, Touch ID, or device passcode.
   */
  authenticate: (reason?: string) =>
    SignalProtocolModule.authenticate(reason),

  /**
   * Check if the user is currently authenticated.
   */
  isAuthenticated: () => SignalProtocolModule.isAuthenticated(),

  /**
   * Lock the keychain, requiring re-authentication.
   */
  lock: () => SignalProtocolModule.lock(),

  /**
   * Extend the authentication timeout.
   */
  extendAuthentication: () => SignalProtocolModule.extendAuthentication(),

  /**
   * Check if the device has a passcode/PIN/pattern configured.
   */
  checkDeviceSecurity: () => SignalProtocolModule.checkDeviceSecurity(),

  /**
   * Check if there is a stored identity key pair.
   */
  hasStoredIdentity: () => SignalProtocolModule.hasStoredIdentity(),

  /**
   * Load the stored local user from secure storage.
   */
  loadStoredLocalUser: () => SignalProtocolModule.loadStoredLocalUser(),

  // ===== AES-256-GCM MEDIA ENCRYPTION =====

  /**
   * Encrypt data with AES-256-GCM using platform-native crypto.
   * Generates a random 256-bit key and 96-bit IV.
   * Returns encrypted data (ciphertext + 16-byte auth tag appended), key, and IV as base64.
   */
  encryptAESGCM: (base64Data: string) =>
    SignalProtocolModule.encryptAESGCM(base64Data),

  /**
   * Decrypt AES-256-GCM encrypted data using platform-native crypto.
   * Expects encrypted data with auth tag appended (last 16 bytes).
   * Returns decrypted data as base64.
   */
  decryptAESGCM: (encryptedBase64: string, keyBase64: string, ivBase64: string) =>
    SignalProtocolModule.decryptAESGCM(encryptedBase64, keyBase64, ivBase64),

  // ===== HARDWARE-PROTECTED GENERIC STORAGE =====
  //
  // Store arbitrary secrets behind the same hardware-backed biometric ACL used
  // for the Signal identity material. Reuses the existing unlock session — no
  // extra biometric prompt. Keys must be namespaced with the `tillit_protected/`
  // prefix; native code enforces this.

  /**
   * Save `dataBase64` under `key` in hardware-protected storage. Requires the
   * user to be authenticated (call `authenticate()` first). Throws if the
   * unlock window has expired.
   */
  setProtectedData: (key: string, dataBase64: string) =>
    SignalProtocolModule.setProtectedData(key, dataBase64),

  /**
   * Read the value stored under `key`. Returns `{ data: null }` if not found.
   * Requires the user to be authenticated.
   */
  getProtectedData: (key: string) =>
    SignalProtocolModule.getProtectedData(key),

  /**
   * Remove the value stored under `key`.
   */
  deleteProtectedData: (key: string) =>
    SignalProtocolModule.deleteProtectedData(key),
};

export default SignalProtocol;
