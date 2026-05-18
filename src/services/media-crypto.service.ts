import SignalProtocol from 'signal-protocol';

class MediaCryptoService {
  /**
   * Encrypt base64 image data with AES-256-GCM using native platform crypto.
   * Returns: { encryptedBase64 (ciphertext + 16-byte authTag appended), keyBase64, ivBase64 }
   */
  async encrypt(base64Data: string): Promise<{ encryptedBase64: string; keyBase64: string; ivBase64: string }> {
    return SignalProtocol.encryptAESGCM(base64Data);
  }

  /**
   * Decrypt AES-256-GCM encrypted data using native platform crypto.
   * The encryptedBase64 contains: ciphertext + authTag (last 16 bytes).
   * Returns decrypted data as base64.
   */
  async decrypt(encryptedBase64: string, keyBase64: string, ivBase64: string): Promise<string> {
    return SignalProtocol.decryptAESGCM(encryptedBase64, keyBase64, ivBase64);
  }
}

export const mediaCryptoService = new MediaCryptoService();