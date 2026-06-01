import Foundation
import ExpoModulesCore
import LibSignalClient
import CryptoKit

/**
 * SignalProtocolModule - Expo Module wrapper for Signal Protocol
 *
 * Security principle: Private keys NEVER leave native code.
 * Only public keys are returned to JavaScript layer.
 */
public class SignalProtocolModule: Module {
    // Store local user once since it's the same for all sessions
    private var localUser: LocalUser?
    // Store multiple sessions, keyed by remote user ID
    // M-10 FIX: Synchronized access via dedicated serial queue
    private var encryptedSessions: [String: EncryptedSession] = [:]
    private let sessionsQueue = DispatchQueue(label: "app.tillit.signal.sessions")
    // Sender key store for group encryption
    private var senderKeyStore: PersistentSenderKeyStore?

    // H6/H7 FIX: Shared stores for pre-keys (all sessions share these)
    private var sharedPreKeyStore: PersistentPreKeyStore?
    private var sharedSignedPreKeyStore: PersistentSignedPreKeyStore?
    private var sharedKyberPreKeyStore: PersistentKyberPreKeyStore?

    // Keys for Keychain storage
    private let identityKeyPairKeychainKey = "local-identity-key-pair"
    private let localUserMetadataKeychainKey = "local-user-metadata"
    // ADR-0010: per-device server-auth credential. A Curve25519 keypair
    // distinct from the (shared) E2E identity — used ONLY to authenticate
    // THIS device to the server. The private key never leaves the device and
    // never enters the E2E protocol. Stored in the protected service so
    // `clearAll()` (clearIdentity / resetIdentityState) wipes it too.
    private let deviceAuthKeyPairKeychainKey = "device-auth-key-pair"

    // M-10 FIX: Thread-safe accessors for encryptedSessions.
    //
    // Multi-device (ADR-0001 D4): the map is keyed by `(userId, deviceId)`
    // so we hold a distinct session per peer device. The encoding uses the
    // ASCII Unit Separator (U+001F) — a control character that cannot
    // legitimately appear inside a userId — so the encoding round-trips
    // unambiguously even if a userId contained `/` or `:` characters.
    // The encoding is in-memory only (never persisted), so changing the
    // separator does not break any stored state. `deviceId` defaults to 1
    // to keep the legacy single-device call sites working unchanged —
    // every caller that has a real deviceId available (message envelope,
    // resumeSession args, /keys/:userId response, etc.) should pass it
    // explicitly so multi-device peers get their own session slot.
    private static let sessionKeySeparator: Character = "\u{001F}"
    private static func sessionKey(_ userId: String, _ deviceId: UInt32) -> String {
        return "\(userId)\(Self.sessionKeySeparator)\(deviceId)"
    }
    private func getSession(_ userId: String, _ deviceId: UInt32 = 1) -> EncryptedSession? {
        sessionsQueue.sync { encryptedSessions[Self.sessionKey(userId, deviceId)] }
    }
    private func setSession(_ userId: String, _ deviceId: UInt32 = 1, session: EncryptedSession) {
        sessionsQueue.sync { encryptedSessions[Self.sessionKey(userId, deviceId)] = session }
    }
    private func removeSession(_ userId: String, _ deviceId: UInt32) {
        sessionsQueue.sync { encryptedSessions.removeValue(forKey: Self.sessionKey(userId, deviceId)) }
    }
    private func removeAllSessions() {
        sessionsQueue.sync { encryptedSessions.removeAll() }
    }

    // Normalize an X25519 public key to libsignal's "DJB" framed form (33
    // bytes prefixed with 0x05). The new device may emit either:
    //   - 33 bytes already in DJB form (libsignal-based clients), in which
    //     case we pass them through unchanged.
    //   - 32 bytes raw X25519 (Web Crypto / libsodium / @stablelib clients,
    //     e.g. the desktop), which we wrap by prepending 0x05.
    // Any other length is left as-is so libsignal raises a clear invalidKey
    // rather than us silently mangling the input.
    private static func normalizeDjbPublicKey(_ data: Data) -> Data {
        if data.count == 32 {
            var out = Data([0x05])
            out.append(data)
            return out
        }
        return data
    }

    // Constant-time byte comparison. Used by the pairing integrity check
    // (peekProvisioningPayload / consumeProvisioningPayload): a server-side
    // attacker who can resubmit candidate payloads must not be able to mount
    // a timing side-channel against the trusted identityKeyPub by varying
    // the candidate byte-by-byte. Short-circuiting `==` would leak the
    // matching prefix length through response time.
    private static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count {
            diff |= a[a.startIndex + i] ^ b[b.startIndex + i]
        }
        return diff == 0
    }

    // Drop all on-device identity material and reset every in-memory store.
    // Shared by `clearIdentity` (user-initiated wipe) and by the catch path
    // in `performIdentitySetup` (rollback when a fresh install fails halfway
    // through, e.g. the Keychain write for the metadata succeeds but the
    // pre-key store write does not). Centralising the cleanup makes the
    // atomicity guarantee in `performIdentitySetup` explicit: either every
    // store ends up populated, or nothing remains.
    private func resetIdentityState() {
        KeychainHelper.shared.clearAll()
        self.localUser = nil
        self.removeAllSessions()

        let senderKeyDirectory = URL(fileURLWithPath: "TilliTSenderKeys")
        self.senderKeyStore = PersistentSenderKeyStore(directoryURL: senderKeyDirectory)
        let sharedStoreDirectory = URL(fileURLWithPath: "TilliTLocalKeys")
        self.sharedPreKeyStore = PersistentPreKeyStore(directoryURL: sharedStoreDirectory)
        self.sharedSignedPreKeyStore = PersistentSignedPreKeyStore(directoryURL: sharedStoreDirectory)
        self.sharedKyberPreKeyStore = PersistentKyberPreKeyStore(directoryURL: sharedStoreDirectory)
    }

    // M-02: Load metadata with migration from standard to protected keychain
    private func loadMetadata() -> Data? {
        let keychain = KeychainHelper.shared
        if let data = keychain.loadProtected(for: localUserMetadataKeychainKey) {
            return data
        }
        // Migrate legacy data from standard keychain
        if let legacyData = keychain.load(for: localUserMetadataKeychainKey) {
            _ = keychain.saveProtected(data: legacyData, for: localUserMetadataKeychainKey)
            keychain.delete(for: localUserMetadataKeychainKey)
            return legacyData
        }
        return nil
    }

    // ADR-0010: return the device-auth private key, creating and persisting
    // a fresh Curve25519 keypair on first access. Lazy creation means this
    // covers every path uniformly — fresh install, linked device after
    // provisioning, and existing installs upgrading to a build that has the
    // device-auth credential — without touching `performIdentitySetup`.
    // Requires an active unlock window (the key lives in protected storage).
    private func loadOrCreateDeviceAuthPrivateKey() throws -> PrivateKey {
        let keychain = KeychainHelper.shared
        guard keychain.isAuthenticated else {
            throw NSError(domain: "SignalProtocol", code: 401,
                userInfo: [NSLocalizedDescriptionKey: "Must call authenticate() first"])
        }
        if let data = keychain.loadProtected(for: self.deviceAuthKeyPairKeychainKey) {
            return try PrivateKey(Array(data))
        }
        // `loadProtected` returned nil. Distinguish a genuine absence (first
        // use → generate) from an existing-but-unreadable item, so we never
        // silently overwrite a key the device already committed to the server.
        if keychain.existsProtected(for: self.deviceAuthKeyPairKeychainKey) {
            throw NSError(domain: "SignalProtocol", code: 500,
                userInfo: [NSLocalizedDescriptionKey: "Failed to load device-auth key"])
        }
        let priv = PrivateKey.generate()
        guard keychain.saveProtected(data: Data(priv.serialize()), for: self.deviceAuthKeyPairKeychainKey) else {
            throw NSError(domain: "SignalProtocol", code: 500,
                userInfo: [NSLocalizedDescriptionKey: "Failed to persist device-auth key"])
        }
        return priv
    }

    // Shared identity-setup path used both by `initializeIdentity` (fresh
    // install or explicit import) and by `consumeProvisioningPayload`
    // (multi-device pairing — the linked device receives the primary's
    // identity inside the decrypted payload and never exposes it to JS).
    // When `importedIdentity` is nil we generate a fresh identity; when
    // non-nil we adopt the provided keypair. All other keys (signed pre-key,
    // pre-keys, kyber pre-keys, registrationId) are always generated fresh
    // — per-device material, never shared across linked devices.
    private func performIdentitySetup(deviceId: Int, name: String, importedIdentity: IdentityKeyPair?) throws -> [String: Any] {
        // Atomicity: any failure between the first persistent write (the
        // identity keypair in the Keychain) and the last (the pre-key /
        // signed-pre-key / kyber stores being populated) is rolled back via
        // `resetIdentityState()`. That avoids the half-installed state
        // where the identity is in the Keychain but `loadStoredLocalUser`
        // can't reconstruct a LocalUser because the metadata or the
        // pre-key store entries are missing — which previously required
        // a reinstall to recover.
        do {
            let keys = try KeyGeneration.generateKeys(existingIdentity: importedIdentity)

            let identityKeyPairData = Data(keys.identityKeyPair.serialize())
            let signedPreKeyRecordData = Data(keys.signedPreKeyRecord.serialize())

            let preKeysArray: [[String: Any]] = keys.preKeys.compactMap { preKeyRecord in
                do {
                    let publicKeyData = try preKeyRecord.publicKey().serialize()
                    return [
                        "id": preKeyRecord.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "key": Data(preKeyRecord.serialize()).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }

            let kyberPreKeysArray: [[String: Any]] = keys.kyberPreKeys.compactMap { kyberPreKey in
                do {
                    let publicKeyData = try kyberPreKey.publicKey().serialize()
                    return [
                        "id": kyberPreKey.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "signature": kyberPreKey.signature.base64EncodedString(),
                        "key": Data(kyberPreKey.serialize()).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }

            let keychain = KeychainHelper.shared

            guard keychain.saveProtected(data: identityKeyPairData, for: self.identityKeyPairKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to save identity key pair"])
            }

            let metadata: [String: Any] = [
                "registrationId": keys.registrationId,
                "deviceId": deviceId,
                "name": name,
                "signedPreKeyRecord": signedPreKeyRecordData.base64EncodedString(),
                "preKeys": preKeysArray,
                "kyberPreKeys": kyberPreKeysArray
            ]

            guard let metadataJson = try? JSONSerialization.data(withJSONObject: metadata),
                  keychain.saveProtected(data: metadataJson, for: self.localUserMetadataKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to save metadata"])
            }

            let localUser = try LocalUser(
                identityKey: keys.identityKeyPair,
                registrationId: UInt32(keys.registrationId),
                preKeys: keys.preKeys,
                signedPreKey: keys.signedPreKeyRecord,
                kyberPreKeys: keys.kyberPreKeys,
                deviceId: UInt32(deviceId),
                name: name
            )
            self.localUser = localUser

            let context = NullContext()
            for preKey in localUser.preKeys {
                try self.sharedPreKeyStore?.storePreKey(preKey, id: preKey.id, context: context)
            }
            try self.sharedSignedPreKeyStore?.storeSignedPreKey(
                localUser.signedPreKey,
                id: localUser.signedPreKey.id,
                context: context
            )
            for kyberPreKey in localUser.kyberPreKeys {
                try self.sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey, id: kyberPreKey.id, context: context)
            }

            return [
            "registrationId": keys.registrationId,
            "deviceId": deviceId,
            "identityPublicKey": keys.identityKeyPublicBase64(),
            "signedPreKey": [
                "id": keys.signedPreKeyId(),
                "publicKey": keys.signedPreKeyPublicKeyBase64(),
                "signature": keys.signedPreKeyRecordSignatureBase64()
            ],
            "preKeys": keys.preKeys.compactMap { preKeyRecord -> [String: Any]? in
                do {
                    let publicKeyData = try preKeyRecord.publicKey().serialize()
                    return [
                        "id": preKeyRecord.id,
                        "publicKey": Data(publicKeyData).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            },
            "kyberPreKeys": keys.kyberPreKeys.compactMap { kyberPreKey -> [String: Any]? in
                do {
                    let publicKeyData = try kyberPreKey.publicKey().serialize()
                    return [
                        "id": kyberPreKey.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "signature": kyberPreKey.signature.base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }
        ]
        } catch {
            // Roll back to a clean state so the next attempt (or a future
            // `loadStoredLocalUser`) doesn't trip over half-installed
            // material. Re-throws the original error so the caller sees the
            // real cause, not the rollback.
            self.resetIdentityState()
            throw error
        }
    }

    // Shared ECDHE + HKDF + AES-256-GCM decrypt for the multi-device
    // provisioning payload. Used both by the low-level `decryptProvisioning`
    // AsyncFunction (exposed for test paths) and by the high-level
    // `consumeProvisioningPayload` AsyncFunction (which never lets the
    // plaintext cross the JS boundary).
    private func decryptProvisioningEnvelope(ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String) throws -> Data {
        guard let envelope = Data(base64Encoded: ciphertextBase64) else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 ciphertext"])
        }
        // 1 byte version + 12 byte IV + ≥1 byte ciphertext + 16 byte tag.
        // The `>= 30` form is equivalent to the previous `> 29` but makes
        // the "ciphertext must be non-empty" intent obvious — a 29-byte
        // envelope with an empty ciphertext would decrypt to nothing useful.
        guard envelope.count >= 1 + 12 + 1 + 16 else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning ciphertext too short"])
        }
        guard envelope[envelope.startIndex] == 0x01 else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported provisioning ciphertext version"])
        }

        let nonceData = envelope.subdata(in: (envelope.startIndex + 1)..<(envelope.startIndex + 13))
        let tagData = envelope.subdata(in: (envelope.endIndex - 16)..<envelope.endIndex)
        let ctData = envelope.subdata(in: (envelope.startIndex + 13)..<(envelope.endIndex - 16))

        guard let recipientPrivData = Data(base64Encoded: recipientPrivateKey),
              let senderPubData = Data(base64Encoded: senderPublicKey) else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 keys"])
        }
        let recipientPriv = try PrivateKey(Array(recipientPrivData))
        let senderPub = try PublicKey(Array(Self.normalizeDjbPublicKey(senderPubData)))
        let sharedSecret = recipientPriv.keyAgreement(with: senderPub)

        let infoString = "tillit/provisioning/v1"
        let derivedKey = try LibSignalClient.hkdf(
            outputLength: 32,
            inputKeyMaterial: sharedSecret,
            salt: Data(),
            info: Array(infoString.utf8)
        )

        let key = SymmetricKey(data: derivedKey)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let aad = Data(infoString.utf8)
        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ctData, tag: tagData)
        return try AES.GCM.open(sealedBox, using: key, authenticating: aad)
    }

    // Shared ECDHE + HKDF + AES-256-GCM encrypt for the multi-device
    // provisioning payload. Returns the binary envelope
    // [1B v=0x01][12B IV][N B ct][16B tag].
    private func encryptProvisioningEnvelope(plaintext: Data, recipientPublicKey: String, senderPrivateKey: String) throws -> Data {
        guard let recipientPubData = Data(base64Encoded: recipientPublicKey),
              let senderPrivData = Data(base64Encoded: senderPrivateKey) else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 input"])
        }
        let recipientPub = try PublicKey(Array(Self.normalizeDjbPublicKey(recipientPubData)))
        let senderPriv = try PrivateKey(Array(senderPrivData))
        let sharedSecret = senderPriv.keyAgreement(with: recipientPub)

        let infoString = "tillit/provisioning/v1"
        let derivedKey = try LibSignalClient.hkdf(
            outputLength: 32,
            inputKeyMaterial: sharedSecret,
            salt: Data(),
            info: Array(infoString.utf8)
        )

        let key = SymmetricKey(data: derivedKey)
        let nonce = AES.GCM.Nonce()
        let aad = Data(infoString.utf8)
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: aad)

        var envelope = Data()
        envelope.append(0x01)
        envelope.append(contentsOf: Array(nonce))
        envelope.append(sealed.ciphertext)
        envelope.append(sealed.tag)
        return envelope
    }

    public func definition() -> ModuleDefinition {
        Name("SignalProtocol")

        OnCreate {
            // Initialize sender key store
            let senderKeyDirectory = URL(fileURLWithPath: "TilliTSenderKeys")
            self.senderKeyStore = PersistentSenderKeyStore(directoryURL: senderKeyDirectory)

            // H6/H7 FIX: Initialize shared pre-key stores
            let sharedStoreDirectory = URL(fileURLWithPath: "TilliTLocalKeys")
            self.sharedPreKeyStore = PersistentPreKeyStore(directoryURL: sharedStoreDirectory)
            self.sharedSignedPreKeyStore = PersistentSignedPreKeyStore(directoryURL: sharedStoreDirectory)
            self.sharedKyberPreKeyStore = PersistentKyberPreKeyStore(directoryURL: sharedStoreDirectory)
        }

        // ========== IDENTITY INITIALIZATION ==========

        AsyncFunction("initializeIdentity") { (deviceId: Int, name: String, existingIdentityKey: [String: String]?) -> [String: Any] in
            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before creating identity"])
            }

            // Multi-device pairing: caller can hand us a pre-existing identity
            // keypair (the linked device receives it from the primary via the
            // provisioning ciphertext). When omitted, generate a fresh one.
            // Wire format is the combined libsignal IdentityKeyPair serialized
            // form (one base64 blob, deserialized via IdentityKeyPair(bytes:))
            // — byte-for-byte identical with the Android side.
            //
            // NOTE: the production multi-device path uses
            // `consumeProvisioningPayload` instead, which keeps the imported
            // identity confined to native code. This `existingIdentityKey`
            // back door is retained for tests and edge-case tooling.
            var importedIdentity: IdentityKeyPair? = nil
            if let existing = existingIdentityKey {
                guard let serializedB64 = existing["serialized"],
                      let serializedData = Data(base64Encoded: serializedB64) else {
                    throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "existingIdentityKey must include base64 `serialized`"])
                }
                importedIdentity = try IdentityKeyPair(bytes: Array(serializedData))
            }

            return try self.performIdentitySetup(deviceId: deviceId, name: name, importedIdentity: importedIdentity)
        }

        AsyncFunction("getPublicIdentity") { () -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            let publicKeyData = localUser.identityKey.publicKey.serialize()
            let identityPublicKey = Data(publicKeyData).base64EncodedString()

            return [
                "identityPublicKey": identityPublicKey,
                "registrationId": localUser.registrationId,
                "deviceId": localUser.deviceId
            ]
        }

        AsyncFunction("getSignedPreKeyInfo") { () -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            let signedPreKey = localUser.signedPreKey
            let publicKeyData = try signedPreKey.publicKey().serialize()

            return [
                "id": signedPreKey.id,
                "publicKey": Data(publicKeyData).base64EncodedString(),
                "signature": Data(signedPreKey.signature).base64EncodedString()
            ]
        }

        AsyncFunction("getFullPublicBundle") { () -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            let identityPublicKey = Data(localUser.identityKey.publicKey.serialize()).base64EncodedString()
            let signedPreKey = localUser.signedPreKey
            let signedPreKeyPublicData = try signedPreKey.publicKey().serialize()

            let preKeys: [[String: Any]] = try localUser.preKeys.compactMap { preKey in
                let publicKeyData = try preKey.publicKey().serialize()
                return [
                    "id": preKey.id,
                    "publicKey": Data(publicKeyData).base64EncodedString()
                ]
            }

            let kyberPreKeys: [[String: Any]] = try localUser.kyberPreKeys.compactMap { kyberPreKey in
                let publicKeyData = try kyberPreKey.publicKey().serialize()
                return [
                    "id": kyberPreKey.id,
                    "publicKey": Data(publicKeyData).base64EncodedString(),
                    "signature": kyberPreKey.signature.base64EncodedString()
                ]
            }

            return [
                "registrationId": localUser.registrationId,
                "deviceId": localUser.deviceId,
                "identityPublicKey": identityPublicKey,
                "signedPreKey": [
                    "id": signedPreKey.id,
                    "publicKey": Data(signedPreKeyPublicData).base64EncodedString(),
                    "signature": Data(signedPreKey.signature).base64EncodedString()
                ],
                "preKeys": preKeys,
                "kyberPreKeys": kyberPreKeys
            ]
        }

        AsyncFunction("clearIdentity") { () in
            // Clear ALL keychain entries (pre-keys, signed pre-keys, kyber pre-keys,
            // sessions, identity keys, sender keys, trust entries, metadata) and
            // re-initialize the in-memory shared stores so stale pre-keys from a
            // previous identity can't be reused after re-login in the same session.
            // Shared with the catch path of `performIdentitySetup` so a failed
            // pairing leaves the device in the same state as an explicit wipe.
            self.resetIdentityState()
        }

        AsyncFunction("setLocalUserId") { (userId: String) -> [String: Any] in
            guard let existingUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            let updatedUser = try LocalUser(
                identityKey: existingUser.identityKey,
                registrationId: existingUser.registrationId,
                preKeys: existingUser.preKeys,
                signedPreKey: existingUser.signedPreKey,
                kyberPreKeys: existingUser.kyberPreKeys,
                deviceId: existingUser.deviceId,
                name: userId
            )
            self.localUser = updatedUser

            let keychain = KeychainHelper.shared
            if let metadataData = self.loadMetadata(),
               var metadata = try? JSONSerialization.jsonObject(with: metadataData) as? [String: Any] {
                metadata["name"] = userId
                if let updatedData = try? JSONSerialization.data(withJSONObject: metadata) {
                    _ = keychain.saveProtected(data: updatedData, for: self.localUserMetadataKeychainKey)
                }
            }

            return ["success": true]
        }

        // ========== KEY ROTATION ==========

        AsyncFunction("replenishPreKeys") { (startId: Int, count: Int) -> [String: Any] in
            guard self.localUser != nil else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before generating keys"])
            }

            let newPreKeys = try KeyGeneration.generatePreKeys(start: UInt32(startId), count: UInt32(count))

            let keychain = KeychainHelper.shared
            guard let metadataJson = self.loadMetadata(),
                  var metadata = try? JSONSerialization.jsonObject(with: metadataJson) as? [String: Any],
                  var existingPreKeys = metadata["preKeys"] as? [[String: Any]] else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to load metadata"])
            }

            let newPreKeysArray: [[String: Any]] = newPreKeys.compactMap { preKeyRecord in
                do {
                    let publicKeyData = try preKeyRecord.publicKey().serialize()
                    return [
                        "id": preKeyRecord.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "key": Data(preKeyRecord.serialize()).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }
            existingPreKeys.append(contentsOf: newPreKeysArray)

            // M-05 FIX: Prevent unbounded metadata growth — keep only most recent 200
            let maxStoredPreKeys = 200
            if existingPreKeys.count > maxStoredPreKeys {
                existingPreKeys = Array(existingPreKeys.suffix(maxStoredPreKeys))
            }

            metadata["preKeys"] = existingPreKeys

            guard let updatedMetadataJson = try? JSONSerialization.data(withJSONObject: metadata),
                  keychain.saveProtected(data: updatedMetadataJson, for: self.localUserMetadataKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to save updated metadata"])
            }

            let context = NullContext()
            for preKey in newPreKeys {
                try self.sharedPreKeyStore?.storePreKey(preKey, id: preKey.id, context: context)
            }

            let publicPreKeys = newPreKeys.compactMap { preKeyRecord -> [String: Any]? in
                do {
                    let publicKeyData = try preKeyRecord.publicKey().serialize()
                    return [
                        "id": preKeyRecord.id,
                        "publicKey": Data(publicKeyData).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }

            return ["preKeys": publicPreKeys]
        }

        AsyncFunction("replenishKyberPreKeys") { (startId: Int, count: Int) -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before generating keys"])
            }

            let newKyberPreKeys = try KeyGeneration.generateKyberPreKeys(
                startId: UInt32(startId),
                count: UInt32(count),
                identityKeyPair: localUser.identityKey
            )

            let keychain = KeychainHelper.shared
            guard let metadataJson = self.loadMetadata(),
                  var metadata = try? JSONSerialization.jsonObject(with: metadataJson) as? [String: Any],
                  var existingKyberPreKeys = metadata["kyberPreKeys"] as? [[String: Any]] else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to load metadata"])
            }

            let newKyberPreKeysArray: [[String: Any]] = newKyberPreKeys.compactMap { kyberPreKey in
                do {
                    let publicKeyData = try kyberPreKey.publicKey().serialize()
                    return [
                        "id": kyberPreKey.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "signature": kyberPreKey.signature.base64EncodedString(),
                        "key": Data(kyberPreKey.serialize()).base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }
            existingKyberPreKeys.append(contentsOf: newKyberPreKeysArray)

            // M-05 FIX: Prevent unbounded metadata growth — keep only most recent 200
            let maxStoredKyberPreKeys = 200
            if existingKyberPreKeys.count > maxStoredKyberPreKeys {
                existingKyberPreKeys = Array(existingKyberPreKeys.suffix(maxStoredKyberPreKeys))
            }

            metadata["kyberPreKeys"] = existingKyberPreKeys

            guard let updatedMetadataJson = try? JSONSerialization.data(withJSONObject: metadata),
                  keychain.saveProtected(data: updatedMetadataJson, for: self.localUserMetadataKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to save updated metadata"])
            }

            let context = NullContext()
            for kyberPreKey in newKyberPreKeys {
                try self.sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey, id: kyberPreKey.id, context: context)
            }

            let publicKyberPreKeys = newKyberPreKeys.compactMap { kyberPreKey -> [String: Any]? in
                do {
                    let publicKeyData = try kyberPreKey.publicKey().serialize()
                    return [
                        "id": kyberPreKey.id,
                        "publicKey": Data(publicKeyData).base64EncodedString(),
                        "signature": kyberPreKey.signature.base64EncodedString()
                    ]
                } catch {
                    return nil
                }
            }

            return ["kyberPreKeys": publicKyberPreKeys]
        }

        AsyncFunction("rotateSignedPreKey") { () -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before rotating keys"])
            }

            let signedPreKeyId = UInt32.random(in: 1...KeyGeneration.maxVal - 1)
            let newSignedPreKey = try KeyGeneration.generateSignedPreKey(
                identityKeyPair: localUser.identityKey,
                signedPreKeyId: signedPreKeyId
            )

            let keychain = KeychainHelper.shared
            guard let metadataJson = self.loadMetadata(),
                  var metadata = try? JSONSerialization.jsonObject(with: metadataJson) as? [String: Any] else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to load metadata"])
            }

            metadata["signedPreKeyRecord"] = Data(newSignedPreKey.serialize()).base64EncodedString()

            guard let updatedMetadataJson = try? JSONSerialization.data(withJSONObject: metadata),
                  keychain.saveProtected(data: updatedMetadataJson, for: self.localUserMetadataKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to save updated metadata"])
            }

            let updatedLocalUser = try LocalUser(
                identityKey: localUser.identityKey,
                registrationId: localUser.registrationId,
                preKeys: localUser.preKeys,
                signedPreKey: newSignedPreKey,
                kyberPreKeys: localUser.kyberPreKeys,
                deviceId: localUser.deviceId,
                name: localUser.name
            )
            self.localUser = updatedLocalUser

            try self.sharedSignedPreKeyStore?.storeSignedPreKey(
                newSignedPreKey,
                id: newSignedPreKey.id,
                context: NullContext()
            )

            let publicKeyData = try newSignedPreKey.publicKey().serialize()
            return [
                "id": newSignedPreKey.id,
                "publicKey": Data(publicKeyData).base64EncodedString(),
                "signature": Data(newSignedPreKey.signature).base64EncodedString()
            ]
        }

        // ========== SESSION MANAGEMENT ==========

        AsyncFunction("setRemoteUserKeys") { (params: [String: Any]) in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard let remoteUserId = params["remoteUserId"] as? String,
                  let preKeyId = params["preKeyId"] as? Int,
                  let preKeyPublicKeyBase64 = params["preKeyPublicKey"] as? String,
                  let signedPreKeyId = params["signedPreKeyId"] as? Int,
                  let signedPreKeyPublicKeyBase64 = params["signedPreKeyPublicKey"] as? String,
                  let signedPreKeySignatureBase64 = params["signedPreKeySignature"] as? String,
                  let identityPublicKeyBase64 = params["identityPublicKey"] as? String,
                  let registrationId = params["registrationId"] as? Int,
                  let deviceId = params["deviceId"] as? Int,
                  let kyberPreKeyId = params["kyberPreKeyId"] as? Int,
                  let kyberPreKeyPublicKeyBase64 = params["kyberPreKeyPublicKey"] as? String,
                  let kyberPreKeySignatureBase64 = params["kyberPreKeySignature"] as? String else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Missing or invalid parameters"])
            }

            guard let preKeyPublicKeyData = Data(base64Encoded: preKeyPublicKeyBase64),
                  let signedPreKeyPublicKeyData = Data(base64Encoded: signedPreKeyPublicKeyBase64),
                  let signedPreKeySignatureData = Data(base64Encoded: signedPreKeySignatureBase64),
                  let identityPublicKeyData = Data(base64Encoded: identityPublicKeyBase64),
                  let kyberPreKeyPublicKeyData = Data(base64Encoded: kyberPreKeyPublicKeyBase64),
                  let kyberPreKeySignatureData = Data(base64Encoded: kyberPreKeySignatureBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 string"])
            }

            let remoteUser = try RemoteUser(
                preKeyId: UInt32(preKeyId),
                preKeyPublicKey: preKeyPublicKeyData,
                signedPreKeyId: UInt32(signedPreKeyId),
                signedPreKeyPublicKey: signedPreKeyPublicKeyData,
                signedPreKeySignature: signedPreKeySignatureData,
                identityKeyPairPublicKey: identityPublicKeyData,
                deviceId: UInt32(deviceId),
                name: remoteUserId,
                registrationId: UInt32(registrationId),
                kyberPreKeyId: UInt32(kyberPreKeyId),
                kyberPreKeyPublicKey: kyberPreKeyPublicKeyData,
                kyberPreKeySignature: kyberPreKeySignatureData
            )

            let session = try EncryptedSession(
                localUser: localUser,
                remoteUser: remoteUser,
                protocolAddress: remoteUser.protocolAddress,
                storageId: remoteUserId,
                sharedPreKeyStore: self.sharedPreKeyStore!,
                sharedSignedPreKeyStore: self.sharedSignedPreKeyStore!,
                sharedKyberPreKeyStore: self.sharedKyberPreKeyStore!
            )
            self.setSession(remoteUserId, UInt32(deviceId), session: session)
        }

        AsyncFunction("establishSession") { (remoteUserId: String, remoteDeviceId: Int?) -> [String: Any] in
            // Multi-device (ADR-0001 D4): the session slot is keyed by
            // `(userId, deviceId)`. The JS caller passes the deviceId for
            // which it just called setRemoteUserKeys; without that the
            // existence check would always look at slot `(userId, 1)` and
            // reject "Session not initialized" for every linked-device peer
            // (deviceId != 1) — even when a valid session was just stored.
            // Default 1 keeps single-device peers unchanged.
            let effectiveDeviceId = UInt32(remoteDeviceId ?? 1)
            guard self.getSession(remoteUserId, effectiveDeviceId) != nil else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }
            return ["status": "Session established successfully"]
        }

        AsyncFunction("resumeSession") { (remoteUserId: String, remoteUserName: String, remoteUserDeviceId: Int) -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            // Memoization (frontend-0016): if a warm EncryptedSession already
            // exists for this (userId, deviceId), reuse it instead of rebuilding.
            // Reconstructing re-creates the per-session store wrappers on every
            // encrypt; the warm instance already carries the Double Ratchet
            // state, so overwriting it is pure overhead. Explicit rebuilds
            // (recovery after a decrypt error, key rotation) go through
            // setRemoteUserKeys, which always creates a fresh session —
            // resumeSession is not the path for that.
            if self.getSession(remoteUserId, UInt32(remoteUserDeviceId)) != nil {
                return ["status": "Session already warm"]
            }

            let remoteUserProtocolAddress = try ProtocolAddress(name: remoteUserId, deviceId: UInt32(remoteUserDeviceId))

            let session = try EncryptedSession(
                localUser: localUser,
                remoteUser: nil,
                protocolAddress: remoteUserProtocolAddress,
                storageId: remoteUserId,
                sharedPreKeyStore: self.sharedPreKeyStore!,
                sharedSignedPreKeyStore: self.sharedSignedPreKeyStore!,
                sharedKyberPreKeyStore: self.sharedKyberPreKeyStore!
            )
            self.setSession(remoteUserId, UInt32(remoteUserDeviceId), session: session)

            return ["status": "Session resumed successfully"]
        }

        // ========== ENCRYPTION/DECRYPTION ==========

        AsyncFunction("encryptMessage") { (message: String, remoteUserId: String, remoteDeviceId: Int?) -> [String: Any] in
            // Multi-device (ADR-0001 D4): look up the session by
            // (userId, deviceId). Default deviceId=1 keeps single-device
            // peers (and call sites that have not been updated to pass
            // the deviceId yet) working unchanged.
            let effectiveDeviceId = UInt32(remoteDeviceId ?? 1)
            guard let session = self.getSession(remoteUserId, effectiveDeviceId) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }

            let encryptedMessage = try session.encrypt(message: message)
            return ["encryptedMessage": encryptedMessage]
        }

        AsyncFunction("decryptMessage") { (encryptedMessage: String, remoteUserId: String, deviceId: Int?) -> [String: Any] in
            // Multi-device (ADR-0001 D4): use the sender's deviceId from
            // the message envelope to find / create the (userId, deviceId)
            // slot in the session map. Default 1 for backward-compat.
            let effectiveDeviceId = UInt32(deviceId ?? 1)
            let session: EncryptedSession
            if let existing = self.getSession(remoteUserId, effectiveDeviceId) {
                session = existing
            } else {
                // Auto-establish: create session without remote keys to handle
                // PreKeySignalMessage (X3DH). libsignal will use our shared
                // pre-key stores to decrypt and establish the session automatically.
                guard let localUser = self.localUser else {
                    throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not set. Ensure loadStoredLocalUser was called."])
                }
                let remoteAddress = try ProtocolAddress(name: remoteUserId, deviceId: effectiveDeviceId)
                session = try EncryptedSession(
                    localUser: localUser,
                    remoteUser: nil,
                    protocolAddress: remoteAddress,
                    storageId: remoteUserId,
                    sharedPreKeyStore: self.sharedPreKeyStore!,
                    sharedSignedPreKeyStore: self.sharedSignedPreKeyStore!,
                    sharedKyberPreKeyStore: self.sharedKyberPreKeyStore!
                )
            }

            if let decryptedMessage = try session.decrypt(message: encryptedMessage) {
                // Decrypt succeeded — persist session (auto-established via PreKeySignalMessage)
                self.setSession(remoteUserId, effectiveDeviceId, session: session)
                return ["message": decryptedMessage]
            } else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Decrypted message is nil"])
            }
        }

        // ========== MULTI-DEVICE PROVISIONING ==========
        //
        // X25519 ECDHE + HKDF-SHA256 + AES-256-GCM helpers used by the
        // multi-device pairing flow. See _shared/api/multi-device-linking.md
        // for the wire contract and _shared/decisions/0001-multi-device-architecture.md
        // (ADR-0001 §D2) for the rationale.

        AsyncFunction("generateProvisioningKeypair") { () -> [String: String] in
            let privateKey = PrivateKey.generate()
            let publicKey = privateKey.publicKey
            return [
                "publicKey": Data(publicKey.serialize()).base64EncodedString(),
                "privateKey": Data(privateKey.serialize()).base64EncodedString()
            ]
        }

        AsyncFunction("encryptProvisioning") {
            (plaintextBase64: String, recipientPublicKey: String, senderPrivateKey: String) -> [String: String] in
            guard let plaintextData = Data(base64Encoded: plaintextBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 plaintext"])
            }
            let envelope = try self.encryptProvisioningEnvelope(
                plaintext: plaintextData,
                recipientPublicKey: recipientPublicKey,
                senderPrivateKey: senderPrivateKey
            )
            return ["ciphertext": envelope.base64EncodedString()]
        }

        AsyncFunction("decryptProvisioning") {
            (ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String) -> [String: String] in
            let plaintext = try self.decryptProvisioningEnvelope(
                ciphertextBase64: ciphertextBase64,
                recipientPrivateKey: recipientPrivateKey,
                senderPublicKey: senderPublicKey
            )
            return ["plaintext": plaintext.base64EncodedString()]
        }

        // High-level pairing wrappers — see ADR-0001 (Option B).
        // The identity private key NEVER crosses the JS boundary.

        AsyncFunction("encryptProvisioningPayload") {
            (recipientPublicKey: String, senderPrivateKey: String, primaryUserId: String, primaryName: String?) -> [String: String] in
            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before reading identity for pairing"])
            }
            // Load the primary's identity from protected storage. Never leaves
            // this function — it is consumed inline to build the payload and
            // discarded (Swift ARC) before the AsyncFunction returns.
            guard let identityKeyPairData = KeychainHelper.shared.loadProtected(for: self.identityKeyPairKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "No identity stored — cannot produce a provisioning payload"])
            }
            let identityKeyPair = try IdentityKeyPair(bytes: Array(identityKeyPairData))
            let identityKeySerialized = Data(identityKeyPair.serialize()).base64EncodedString()
            let identityKeyPub = Data(identityKeyPair.publicKey.serialize()).base64EncodedString()

            var payload: [String: Any] = [
                "v": 1,
                "identityKeySerialized": identityKeySerialized,
                "identityKeyPub": identityKeyPub,
                "primaryUserId": primaryUserId
            ]
            if let name = primaryName {
                payload["primaryName"] = name
            }
            guard let plaintextData = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize provisioning payload"])
            }

            let envelope = try self.encryptProvisioningEnvelope(
                plaintext: plaintextData,
                recipientPublicKey: recipientPublicKey,
                senderPrivateKey: senderPrivateKey
            )
            return ["ciphertext": envelope.base64EncodedString()]
        }

        AsyncFunction("peekProvisioningPayload") {
            (ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String) -> [String: Any] in
            // Decrypt and integrity-check the provisioning payload WITHOUT
            // installing the identity. Used by the new device to compute the
            // pairing safety number and show it to the user before committing
            // anything to persistent state.
            //
            // M4: explicit buffer wipe on every exit path. ARC alone leaves
            // the decrypted plaintext (which contains the primary's identity
            // private key in serialized form) in heap memory until the next
            // GC sweep. `defer` + `resetBytes(in:)` zero it before the function
            // returns — defense-in-depth against crash dumps or memory
            // disclosure between use and reclamation.
            var plaintext = try self.decryptProvisioningEnvelope(
                ciphertextBase64: ciphertextBase64,
                recipientPrivateKey: recipientPrivateKey,
                senderPublicKey: senderPublicKey
            )
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }

            guard let parsed = try? JSONSerialization.jsonObject(with: plaintext, options: []) as? [String: Any] else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload is not valid JSON"])
            }
            guard let version = parsed["v"] as? Int, version == 1 else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported provisioning payload version"])
            }
            guard let serializedB64 = parsed["identityKeySerialized"] as? String,
                  let identityPubB64 = parsed["identityKeyPub"] as? String,
                  let primaryUserId = parsed["primaryUserId"] as? String,
                  var serializedData = Data(base64Encoded: serializedB64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload missing required fields"])
            }
            defer { serializedData.resetBytes(in: 0..<serializedData.count) }

            // Integrity check: identityKeyPub must equal the public half of
            // the deserialized keypair. Catches a tampered payload here, BEFORE
            // we hand the resulting safety number to the user. Compared in
            // constant time so a server-side attacker cannot mount a timing
            // side-channel against the trusted identityKeyPub.
            let importedIdentity = try IdentityKeyPair(bytes: Array(serializedData))
            let recoveredPubData = Data(importedIdentity.publicKey.serialize())
            guard let claimedPubData = Data(base64Encoded: identityPubB64),
                  Self.constantTimeEquals(recoveredPubData, claimedPubData) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload integrity check failed: identityKeyPub does not match identityKeySerialized"])
            }

            // `importedIdentity` and the deserialized blob go out of scope at
            // function exit — Swift ARC zeroes the heap, the private key is
            // never persisted or returned.
            var result: [String: Any] = [
                "primaryUserId": primaryUserId,
                "identityKeyPub": identityPubB64
            ]
            if let primaryName = parsed["primaryName"] as? String {
                result["primaryName"] = primaryName
            }
            return result
        }

        AsyncFunction("consumeProvisioningPayload") {
            (ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String, deviceId: Int, name: String) -> [String: Any] in
            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before installing a provisioned identity"])
            }

            // M4: explicit buffer wipe — see the matching block in
            // peekProvisioningPayload for the rationale. Even when the
            // identity is committed to the Keychain successfully, the
            // intermediate `plaintext` + base64-decoded `serializedData`
            // copies must not linger in the heap.
            var plaintext = try self.decryptProvisioningEnvelope(
                ciphertextBase64: ciphertextBase64,
                recipientPrivateKey: recipientPrivateKey,
                senderPublicKey: senderPublicKey
            )
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }

            guard let parsed = try? JSONSerialization.jsonObject(with: plaintext, options: []) as? [String: Any] else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload is not valid JSON"])
            }
            guard let version = parsed["v"] as? Int, version == 1 else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unsupported provisioning payload version"])
            }
            guard let serializedB64 = parsed["identityKeySerialized"] as? String,
                  let identityPubB64 = parsed["identityKeyPub"] as? String,
                  var serializedData = Data(base64Encoded: serializedB64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload missing required fields"])
            }
            defer { serializedData.resetBytes(in: 0..<serializedData.count) }

            let importedIdentity = try IdentityKeyPair(bytes: Array(serializedData))

            // Cross-check: the embedded identityKeyPub MUST match the public
            // key we recover from the serialized keypair. Detects a malformed
            // or tampered payload before it reaches the Keychain. Compared in
            // constant time so a server-side attacker cannot mount a timing
            // side-channel against the trusted identityKeyPub.
            let recoveredPubData = Data(importedIdentity.publicKey.serialize())
            guard let claimedPubData = Data(base64Encoded: identityPubB64),
                  Self.constantTimeEquals(recoveredPubData, claimedPubData) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Provisioning payload integrity check failed: identityKeyPub does not match identityKeySerialized"])
            }

            return try self.performIdentitySetup(deviceId: deviceId, name: name, importedIdentity: importedIdentity)
        }

        AsyncFunction("getPairingSafetyNumber") {
            (ephemeralPubA: String, ephemeralPubB: String, identityPub: String, primaryUserId: String) -> [String: String] in

            guard let aData = Data(base64Encoded: ephemeralPubA),
                  let bData = Data(base64Encoded: ephemeralPubB),
                  let idData = Data(base64Encoded: identityPub) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 public key"])
            }

            // Transcript hash: SHA-256(A || B || identityPub)
            var hasher = SHA256()
            hasher.update(data: aData)
            hasher.update(data: bData)
            hasher.update(data: idData)
            let transcript = Data(hasher.finalize())

            // HKDF: salt = "tillit/pairing/sn/v1", info = primaryUserId, L = 30
            let snBytes = try LibSignalClient.hkdf(
                outputLength: 30,
                inputKeyMaterial: transcript,
                salt: Array("tillit/pairing/sn/v1".utf8),
                info: Array(primaryUserId.utf8)
            )

            // 30 B → 6 blocks of 5 B → uint40 → mod 10^10 → 10 zero-padded digits → 60 total
            let bytes = Array(snBytes)
            var digits = ""
            for blockIdx in 0..<6 {
                var v: UInt64 = 0
                for byteIdx in 0..<5 {
                    v = (v << 8) | UInt64(bytes[blockIdx * 5 + byteIdx])
                }
                v = v % 10_000_000_000
                digits += String(format: "%010llu", v)
            }
            // Format as 12 groups of 5 digits separated by single spaces.
            var groups: [String] = []
            var cursor = digits.startIndex
            for _ in 0..<12 {
                let end = digits.index(cursor, offsetBy: 5)
                groups.append(String(digits[cursor..<end]))
                cursor = end
            }
            return ["safetyNumber": groups.joined(separator: " ")]
        }

        // ========== REMOTE SESSION MANAGEMENT (multi-device revocation) ==========

        AsyncFunction("deleteRemoteSession") { (remoteUserId: String, remoteDeviceId: Int?) in
            // Multi-device (ADR-0001 D6): drop only the session for the
            // revoked (userId, deviceId). Other devices of the same peer
            // keep encrypting/decrypting normally.
            self.removeSession(remoteUserId, UInt32(remoteDeviceId ?? 1))
        }

        // ========== IDENTITY VERIFICATION ==========

        AsyncFunction("getSafetyNumber") { (remoteUserId: String) -> [String: Any] in
            guard let session = self.getSession(remoteUserId) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }

            let context = NullContext()
            guard let remoteIdentity = try session.identityStore.identity(for: session.remoteUserProtocolAddress, context: context) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "No identity found"])
            }

            let safetyNumber = try session.identityStore.generateSafetyNumber(localUserId: self.localUser!.name, for: session.remoteUserProtocolAddress, remoteIdentity: remoteIdentity)
            return ["safetyNumber": safetyNumber]
        }

        AsyncFunction("verifyIdentity") { (remoteUserId: String) -> [String: Any] in
            guard let session = self.getSession(remoteUserId) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }

            let context = NullContext()
            guard let remoteIdentity = try session.identityStore.identity(for: session.remoteUserProtocolAddress, context: context) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "No identity found"])
            }

            try session.identityStore.setManuallyTrusted(remoteIdentity, for: session.remoteUserProtocolAddress)
            return ["status": "Identity verified and marked as trusted"]
        }

        AsyncFunction("checkIdentityKeyChanged") { (remoteUserId: String, identityKey: String?) -> [String: Any] in
            guard let session = self.getSession(remoteUserId) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }

            let context = NullContext()
            let storedIdentity = try session.identityStore.identity(for: session.remoteUserProtocolAddress, context: context)

            if storedIdentity == nil {
                return ["changed": false, "reason": "No identity saved yet"]
            }

            if let newIdentityKeyBase64 = identityKey {
                guard let newIdentityKeyData = Data(base64Encoded: newIdentityKeyBase64) else {
                    throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 identityKey"])
                }

                let newIdentityKey = try IdentityKey(bytes: [UInt8](newIdentityKeyData))
                let hasChanged = storedIdentity != newIdentityKey

                var result: [String: Any] = [
                    "changed": hasChanged,
                    "identityExists": true
                ]

                if hasChanged {
                    result["previousKey"] = Data(storedIdentity!.serialize()).base64EncodedString()
                }

                return result
            }

            return ["changed": false, "identityExists": true]
        }

        // ========== SENDER KEYS (GROUP ENCRYPTION) ==========

        AsyncFunction("createSenderKeySession") { (roomId: String, distributionIdString: String) -> [String: Any] in
            guard let distributionId = UUID(uuidString: distributionIdString) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid distributionId"])
            }

            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }

            let localAddress = try ProtocolAddress(name: localUser.name, deviceId: localUser.deviceId)
            let context = NullContext()

            let distributionMessage = try SenderKeyDistributionMessage(
                from: localAddress,
                distributionId: distributionId,
                store: store,
                context: context
            )

            let serialized = distributionMessage.serialize()
            let base64 = Data(serialized).base64EncodedString()

            return ["distributionMessage": base64]
        }

        AsyncFunction("processSenderKeyDistribution") { (roomId: String, senderId: String, distributionMessageBase64: String, senderDeviceId: Int?) in
            guard let distributionData = Data(base64Encoded: distributionMessageBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64"])
            }

            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }

            let context = NullContext()
            let distributionMessage = try SenderKeyDistributionMessage(bytes: distributionData)
            let senderAddress = try ProtocolAddress(name: senderId, deviceId: UInt32(senderDeviceId ?? 1))

            try processSenderKeyDistributionMessage(
                distributionMessage,
                from: senderAddress,
                store: store,
                context: context
            )
        }

        AsyncFunction("encryptGroupMessage") { (message: String, roomId: String, distributionIdString: String) -> [String: Any] in
            guard let distributionId = UUID(uuidString: distributionIdString) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid distributionId"])
            }

            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }

            let localAddress = try ProtocolAddress(name: localUser.name, deviceId: localUser.deviceId)
            let context = NullContext()

            let plaintext = Data(message.utf8)
            let ciphertext = try groupEncrypt(
                plaintext,
                from: localAddress,
                distributionId: distributionId,
                store: store,
                context: context
            )

            let base64 = Data(ciphertext.serialize()).base64EncodedString()
            return ["ciphertext": base64]
        }

        AsyncFunction("decryptGroupMessage") { (ciphertextBase64: String, roomId: String, senderId: String, senderDeviceId: Int?) -> [String: Any] in
            guard let ciphertextData = Data(base64Encoded: ciphertextBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64"])
            }

            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }

            let context = NullContext()
            let senderAddress = try ProtocolAddress(name: senderId, deviceId: UInt32(senderDeviceId ?? 1))

            let plaintext = try groupDecrypt(
                [UInt8](ciphertextData),
                from: senderAddress,
                store: store,
                context: context
            )

            let message = String(data: Data(plaintext), encoding: .utf8) ?? ""
            return ["message": message]
        }

        AsyncFunction("rotateSenderKey") { (roomId: String) -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }

            let localAddress = try ProtocolAddress(name: localUser.name, deviceId: localUser.deviceId)
            let context = NullContext()
            let newDistributionId = UUID()

            let distributionMessage = try SenderKeyDistributionMessage(
                from: localAddress,
                distributionId: newDistributionId,
                store: store,
                context: context
            )

            let serialized = distributionMessage.serialize()
            let base64 = Data(serialized).base64EncodedString()

            return [
                "distributionMessage": base64,
                "distributionId": newDistributionId.uuidString
            ]
        }

        AsyncFunction("deleteSenderKeySession") { (roomId: String) in
            guard let store = self.senderKeyStore else {
                throw NSError(domain: "SignalProtocol", code: 500,
                    userInfo: [NSLocalizedDescriptionKey: "Sender key store not initialized"])
            }
            store.deleteAllSenderKeys(withPrefix: roomId)
        }

        // ========== AUTHENTICATION ==========

        AsyncFunction("signWithIdentityKey") { (dataBase64: String) -> [String: Any] in
            guard let dataToSign = Data(base64Encoded: dataBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 data"])
            }

            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
            }

            let signature = localUser.identityKey.privateKey.generateSignature(message: dataToSign)
            let signatureBase64 = signature.base64EncodedString()
            return ["signature": signatureBase64]
        }

        // ADR-0010: expose the public half of this device's server-auth key
        // (libsignal Curve25519, 33B type-prefixed). Registered via POST /keys.
        AsyncFunction("getDeviceAuthPublicKey") { () -> [String: Any] in
            let priv = try self.loadOrCreateDeviceAuthPrivateKey()
            return ["publicKey": Data(priv.publicKey.serialize()).base64EncodedString()]
        }

        // ADR-0010: sign the (same domain-separated) auth challenge with the
        // device-auth private key. Sent as `deviceAuthSignature` alongside the
        // identity `challengeSignature` at POST /auth/identity. Same XEdDSA
        // primitive as `signWithIdentityKey`.
        AsyncFunction("signWithDeviceAuth") { (dataBase64: String) -> [String: Any] in
            guard let dataToSign = Data(base64Encoded: dataBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 data"])
            }
            let priv = try self.loadOrCreateDeviceAuthPrivateKey()
            let signature = priv.generateSignature(message: dataToSign)
            return ["signature": signature.base64EncodedString()]
        }

        // ========== BIOMETRIC/PASSCODE AUTHENTICATION ==========

        AsyncFunction("authenticate") { (reason: String?, promise: Promise) in
            let authReason = reason ?? "Sblocca le chiavi di cifratura"

            KeychainHelper.shared.authenticate(reason: authReason) { success, error in
                if success {
                    promise.resolve(["success": true])
                } else {
                    let errorMessage = error?.localizedDescription ?? "Authentication failed"
                    promise.resolve(["success": false, "error": errorMessage])
                }
            }
        }

        Function("isAuthenticated") { () -> [String: Any] in
            let authenticated = KeychainHelper.shared.isAuthenticated
            return ["authenticated": authenticated]
        }

        Function("lock") { () in
            KeychainHelper.shared.lock()
        }

        Function("extendAuthentication") { () -> [String: Any] in
            KeychainHelper.shared.touchAuthentication()
            return ["success": true]
        }

        // ========== HARDWARE-PROTECTED GENERIC STORAGE ==========
        // Surface KeychainHelper.saveProtected/loadProtected to JS so consumers
        // (e.g. SQLCipher DB key) can store arbitrary secrets behind the same
        // biometric ACL used by the Signal identity material — instead of using
        // expo-secure-store with `requireAuthentication: true`, which would
        // produce a separate biometric prompt because it manages its own LAContext.
        //
        // The "tillit_protected/" prefix is enforced to keep the namespace
        // separate from Signal-internal keys and to allow targeted cleanup.

        AsyncFunction("setProtectedData") { (key: String, dataBase64: String) -> [String: Any] in
            guard key.hasPrefix("tillit_protected/") else {
                throw NSError(domain: "SignalProtocol", code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Protected keys must use the tillit_protected/ prefix"])
            }
            guard let data = Data(base64Encoded: dataBase64) else {
                throw NSError(domain: "SignalProtocol", code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid base64 data"])
            }
            let saved = KeychainHelper.shared.saveProtected(data: data, for: key)
            if !saved {
                throw NSError(domain: "SignalProtocol", code: 401,
                    userInfo: [NSLocalizedDescriptionKey: "Not authenticated or keychain write failed"])
            }
            return ["success": true]
        }

        AsyncFunction("getProtectedData") { (key: String) -> [String: Any] in
            guard key.hasPrefix("tillit_protected/") else {
                throw NSError(domain: "SignalProtocol", code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Protected keys must use the tillit_protected/ prefix"])
            }
            if let data = KeychainHelper.shared.loadProtected(for: key) {
                return ["data": data.base64EncodedString()]
            }
            return ["data": NSNull()]
        }

        AsyncFunction("deleteProtectedData") { (key: String) -> [String: Any] in
            guard key.hasPrefix("tillit_protected/") else {
                throw NSError(domain: "SignalProtocol", code: 400,
                    userInfo: [NSLocalizedDescriptionKey: "Protected keys must use the tillit_protected/ prefix"])
            }
            let deleted = KeychainHelper.shared.deleteProtected(for: key)
            return ["success": deleted]
        }

        Function("checkDeviceSecurity") { () -> [String: Any] in
            let isSecure = KeychainHelper.shared.isDeviceSecure()
            return ["isSecure": isSecure]
        }

        Function("hasStoredIdentity") { () -> [String: Any] in
            let keychain = KeychainHelper.shared
            let hasIdentity = keychain.existsProtected(for: self.identityKeyPairKeychainKey)
            let hasMetadata = keychain.existsProtected(for: self.localUserMetadataKeychainKey) || keychain.exists(for: self.localUserMetadataKeychainKey)
            return ["hasStoredIdentity": hasIdentity && hasMetadata]
        }

        AsyncFunction("loadStoredLocalUser") { () -> [String: Any] in
            let keychain = KeychainHelper.shared

            guard keychain.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must call authenticate() first"])
            }

            guard let identityKeyPairData = keychain.loadProtected(for: self.identityKeyPairKeychainKey) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "No stored identity key pair found"])
            }

            guard let metadataJson = self.loadMetadata(),
                  let metadata = try? JSONSerialization.jsonObject(with: metadataJson) as? [String: Any],
                  let registrationId = metadata["registrationId"] as? Int,
                  let deviceId = metadata["deviceId"] as? Int,
                  let name = metadata["name"] as? String,
                  let signedPreKeyRecordBase64 = metadata["signedPreKeyRecord"] as? String,
                  let preKeysArray = metadata["preKeys"] as? [[String: Any]],
                  let kyberPreKeysArray = metadata["kyberPreKeys"] as? [[String: Any]] else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to load local user metadata"])
            }

            let identityKeyPair = try IdentityKeyPair(bytes: identityKeyPairData)

            var preKeys = [PreKeyRecord]()
            for preKeyDict in preKeysArray {
                if let keyBase64 = preKeyDict["key"] as? String,
                   let keyData = Data(base64Encoded: keyBase64) {
                    let key = try PreKeyRecord(bytes: keyData)
                    preKeys.append(key)
                }
            }

            let signedPreKeyRecordData = Data(base64Encoded: signedPreKeyRecordBase64) ?? Data()
            let signedPreKeyRecord = try SignedPreKeyRecord(bytes: signedPreKeyRecordData)

            var kyberPreKeysRecords = [KyberPreKeyRecord]()
            for kyberPreKey in kyberPreKeysArray {
                if let kk = kyberPreKey["key"] as? String,
                   let kpk = Data(base64Encoded: kk) {
                    let kybrPreKeyRecord = try KyberPreKeyRecord(bytes: kpk)
                    kyberPreKeysRecords.append(kybrPreKeyRecord)
                }
            }

            let localUser = try LocalUser(
                identityKey: identityKeyPair,
                registrationId: UInt32(registrationId),
                preKeys: preKeys,
                signedPreKey: signedPreKeyRecord,
                kyberPreKeys: kyberPreKeysRecords,
                deviceId: UInt32(deviceId),
                name: name
            )

            self.localUser = localUser

            let context = NullContext()
            for preKey in localUser.preKeys {
                try self.sharedPreKeyStore?.storePreKey(preKey, id: preKey.id, context: context)
            }
            try self.sharedSignedPreKeyStore?.storeSignedPreKey(
                localUser.signedPreKey,
                id: localUser.signedPreKey.id,
                context: context
            )
            for kyberPreKey in localUser.kyberPreKeys {
                try self.sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey, id: kyberPreKey.id, context: context)
            }

            return ["success": true]
        }

        // ========== AES-256-GCM MEDIA ENCRYPTION ==========

        AsyncFunction("encryptAESGCM") { (base64Data: String) -> [String: String] in
            return try self.performAESGCMEncrypt(base64Data: base64Data)
        }

        AsyncFunction("decryptAESGCM") { (encryptedBase64: String, keyBase64: String, ivBase64: String) -> String in
            return try self.performAESGCMDecrypt(encryptedBase64: encryptedBase64, keyBase64: keyBase64, ivBase64: ivBase64)
        }
    }

    // MARK: - AES-256-GCM helpers (CryptoKit)

    private func performAESGCMEncrypt(base64Data: String) throws -> [String: String] {
        guard let data = Data(base64Encoded: base64Data) else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 input"])
        }

        let key = SymmetricKey(size: .bits256)
        let nonce = AES.GCM.Nonce()
        let sealedBox = try AES.GCM.seal(data, using: key, nonce: nonce)

        // ciphertext + tag combined (same format as Android: GCM appends tag)
        guard let combined = sealedBox.combined else {
            throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "AES-GCM seal returned no combined data"])
        }

        // combined = nonce (12) + ciphertext + tag (16)
        // We need: ciphertext + tag (without nonce prefix), matching Android format
        let encryptedWithTag = combined.dropFirst(12)

        return [
            "encryptedBase64": encryptedWithTag.base64EncodedString(),
            "keyBase64": key.withUnsafeBytes { Data($0).base64EncodedString() },
            "ivBase64": Data(nonce).base64EncodedString()
        ]
    }

    private func performAESGCMDecrypt(encryptedBase64: String, keyBase64: String, ivBase64: String) throws -> String {
        guard let encryptedWithTag = Data(base64Encoded: encryptedBase64),
              let keyData = Data(base64Encoded: keyBase64),
              let ivData = Data(base64Encoded: ivBase64) else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 input"])
        }

        guard encryptedWithTag.count > 16 else {
            throw NSError(domain: "SignalProtocol", code: 400, userInfo: [NSLocalizedDescriptionKey: "Encrypted data too short"])
        }

        let key = SymmetricKey(data: keyData)
        let nonce = try AES.GCM.Nonce(data: ivData)

        let ciphertext = encryptedWithTag.prefix(encryptedWithTag.count - 16)
        let tag = encryptedWithTag.suffix(16)

        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let decryptedData = try AES.GCM.open(sealedBox, using: key)

        return decryptedData.base64EncodedString()
    }
}
