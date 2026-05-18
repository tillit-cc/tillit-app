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
} from './SignalProtocol.types';

// Re-export types
export * from './SignalProtocol.types';

// Native module interface - matches Swift AsyncFunction/Function signatures
interface SignalProtocolModuleInterface extends NativeModule {
  // ===== IDENTITY INITIALIZATION =====
  initializeIdentity(deviceId: number, name: string): Promise<PublicKeyBundle>;
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
  establishSession(remoteUserId: string): Promise<SessionResult>;
  resumeSession(
    remoteUserId: string,
    remoteUserName: string,
    remoteUserDeviceId: number
  ): Promise<SessionResult>;

  // ===== ENCRYPTION/DECRYPTION =====
  encryptMessage(message: string, remoteUserId: string): Promise<EncryptResult>;
  decryptMessage(encryptedMessage: string, remoteUserId: string, deviceId?: number | null): Promise<DecryptResult>;

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
   * Generate a new identity, save private keys in protected Keychain,
   * and return ONLY the public keys for server upload.
   *
   * MUST call authenticate() BEFORE this method to access protected Keychain.
   */
  initializeIdentity: (deviceId: number, name: string) =>
    SignalProtocolModule.initializeIdentity(deviceId, name),

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
   */
  establishSession: (remoteUserId: string) =>
    SignalProtocolModule.establishSession(remoteUserId),

  /**
   * Resume an existing session with a remote user.
   */
  resumeSession: (remoteUserId: string, remoteUserName: string, remoteUserDeviceId: number) =>
    SignalProtocolModule.resumeSession(remoteUserId, remoteUserName, remoteUserDeviceId),

  // ===== ENCRYPTION/DECRYPTION =====

  /**
   * Encrypt a message for a remote user.
   */
  encryptMessage: (message: string, remoteUserId: string) =>
    SignalProtocolModule.encryptMessage(message, remoteUserId),

  /**
   * Decrypt a message from a remote user.
   */
  decryptMessage: (encryptedMessage: string, remoteUserId: string, deviceId?: number | null) =>
    SignalProtocolModule.decryptMessage(encryptedMessage, remoteUserId, deviceId ?? null),

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
