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

    // M-10 FIX: Thread-safe accessors for encryptedSessions
    private func getSession(_ userId: String) -> EncryptedSession? {
        sessionsQueue.sync { encryptedSessions[userId] }
    }
    private func setSession(_ userId: String, session: EncryptedSession) {
        sessionsQueue.sync { encryptedSessions[userId] = session }
    }
    private func removeAllSessions() {
        sessionsQueue.sync { encryptedSessions.removeAll() }
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

        AsyncFunction("initializeIdentity") { (deviceId: Int, name: String) -> [String: Any] in
            guard KeychainHelper.shared.isAuthenticated else {
                throw NSError(domain: "SignalProtocol", code: 401, userInfo: [NSLocalizedDescriptionKey: "Must authenticate before creating identity"])
            }

            let keys = try KeyGeneration.generateKeys()

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
                keychain.delete(for: self.identityKeyPairKeychainKey)
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

            let publicBundle: [String: Any] = [
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

            return publicBundle
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
            // sessions, identity keys, sender keys, trust entries, metadata)
            // to prevent orphaned entries accumulating across identity re-creations
            KeychainHelper.shared.clearAll()
            self.localUser = nil
            self.removeAllSessions()

            // H-01 FIX: Re-initialize all shared stores to prevent stale pre-keys
            // from a previous identity being used after re-login in the same app session
            let senderKeyDirectory = URL(fileURLWithPath: "TilliTSenderKeys")
            self.senderKeyStore = PersistentSenderKeyStore(directoryURL: senderKeyDirectory)
            let sharedStoreDirectory = URL(fileURLWithPath: "TilliTLocalKeys")
            self.sharedPreKeyStore = PersistentPreKeyStore(directoryURL: sharedStoreDirectory)
            self.sharedSignedPreKeyStore = PersistentSignedPreKeyStore(directoryURL: sharedStoreDirectory)
            self.sharedKyberPreKeyStore = PersistentKyberPreKeyStore(directoryURL: sharedStoreDirectory)
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
            self.setSession(remoteUserId, session: session)
        }

        AsyncFunction("establishSession") { (remoteUserId: String) -> [String: Any] in
            guard self.getSession(remoteUserId) != nil else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }
            return ["status": "Session established successfully"]
        }

        AsyncFunction("resumeSession") { (remoteUserId: String, remoteUserName: String, remoteUserDeviceId: Int) -> [String: Any] in
            guard let localUser = self.localUser else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not loaded"])
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
            self.setSession(remoteUserId, session: session)

            return ["status": "Session resumed successfully"]
        }

        // ========== ENCRYPTION/DECRYPTION ==========

        AsyncFunction("encryptMessage") { (message: String, remoteUserId: String) -> [String: Any] in
            guard let session = self.getSession(remoteUserId) else {
                throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Session not initialized"])
            }

            let encryptedMessage = try session.encrypt(message: message)
            return ["encryptedMessage": encryptedMessage]
        }

        AsyncFunction("decryptMessage") { (encryptedMessage: String, remoteUserId: String, deviceId: Int?) -> [String: Any] in
            let session: EncryptedSession
            if let existing = self.getSession(remoteUserId) {
                session = existing
            } else {
                // Auto-establish: create session without remote keys to handle
                // PreKeySignalMessage (X3DH). libsignal will use our shared
                // pre-key stores to decrypt and establish the session automatically.
                guard let localUser = self.localUser else {
                    throw NSError(domain: "SignalProtocol", code: 404, userInfo: [NSLocalizedDescriptionKey: "Local user not set. Ensure loadStoredLocalUser was called."])
                }
                // M-01 FIX: Use deviceId from message metadata, fallback to 1
                let remoteAddress = try ProtocolAddress(name: remoteUserId, deviceId: UInt32(deviceId ?? 1))
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
                self.setSession(remoteUserId, session: session)
                return ["message": decryptedMessage]
            } else {
                throw NSError(domain: "SignalProtocol", code: 500, userInfo: [NSLocalizedDescriptionKey: "Decrypted message is nil"])
            }
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
