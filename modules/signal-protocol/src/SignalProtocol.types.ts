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
