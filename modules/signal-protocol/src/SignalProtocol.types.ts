// ===== PUBLIC KEY TYPES (returned to JavaScript) =====

export interface PublicPreKey {
  id: number;
  publicKey: string;
}

export interface PublicKyberPreKey {
  id: number;
  publicKey: string;
  signature: string;
}

export interface SignedPreKeyInfo {
  id: number;
  publicKey: string;
  signature: string;
}

export interface PublicKeyBundle {
  registrationId: number;
  deviceId: number;
  identityPublicKey: string;
  signedPreKey: SignedPreKeyInfo;
  preKeys: PublicPreKey[];
  kyberPreKeys: PublicKyberPreKey[];
}

export interface PublicIdentity {
  identityPublicKey: string;
  registrationId: number;
  deviceId: number;
}

// ===== REMOTE USER KEYS (for establishing sessions) =====

export interface RemoteUserKeys {
  remoteUserId: string;
  preKeyId: number;
  preKeyPublicKey: string;
  signedPreKeyId: number;
  signedPreKeyPublicKey: string;
  signedPreKeySignature: string;
  identityPublicKey: string;
  registrationId: number;
  deviceId: number;
  name: string;
  // Post-quantum Kyber parameters (required)
  kyberPreKeyId: number;
  kyberPreKeyPublicKey: string;
  kyberPreKeySignature: string;
}

// ===== RESULT TYPES =====

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface EncryptResult {
  encryptedMessage: string;
}

export interface DecryptResult {
  message: string;
}

export interface SessionResult {
  status: string;
}

export interface SignatureResult {
  signature: string;
}

export interface SafetyNumberResult {
  safetyNumber: string;
}

export interface IdentityCheckResult {
  changed: boolean;
  identityExists?: boolean;
  reason?: string;
  previousKey?: string;
}

export interface SenderKeyResult {
  distributionMessage: string;
  distributionId?: string;
}

export interface GroupEncryptResult {
  ciphertext: string;
}

// ===== MULTI-DEVICE PROVISIONING =====
//
// See _shared/decisions/0001-multi-device-architecture.md (ADR-0001) and
// _shared/api/multi-device-linking.md for the full contract.

export interface ExistingIdentityKey {
  /**
   * Base64 of the libsignal `IdentityKeyPair` serialized form (combined
   * public + private). Both platforms can roundtrip this via
   * `IdentityKeyPair(serialized)` so it is the canonical wire format for
   * cross-device identity transfer during pairing.
   */
  serialized: string;
}

export interface ProvisioningKeypair {
  /** Base64 of the 32-byte ephemeral X25519 public key. */
  publicKey: string;
  /** Base64 of the 32-byte ephemeral X25519 private key. */
  privateKey: string;
}

export interface EncryptProvisioningResult {
  /**
   * Base64 of the provisioning ciphertext.
   * Layout: [1B version=0x01][12B AES-GCM IV][N B ciphertext][16B GCM tag]
   * AAD: "tillit/provisioning/v1"
   */
  ciphertext: string;
}

export interface DecryptProvisioningResult {
  /** Base64 of the decrypted plaintext. */
  plaintext: string;
}

export interface PairingSafetyNumberResult {
  /**
   * 60 decimal digits formatted as 12 groups of 5 separated by single spaces.
   * E.g. "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
   */
  safetyNumber: string;
}

/**
 * Result of `peekProvisioningPayload`. Contains only the public fields of
 * the decrypted provisioning payload — the identity private key is read
 * out and immediately discarded by the native module. The new device uses
 * this to compute the pairing safety number and present it to the user
 * BEFORE installing the identity (via `consumeProvisioningPayload`).
 */
export interface PeekProvisioningResult {
  primaryUserId: string;
  identityKeyPub: string;
  primaryName?: string;
}
