import Foundation
import LibSignalClient

class EncryptedSession {

    final let localUser: LocalUser
    final var remoteUser: RemoteUser?
    final let remoteUserProtocolAddress: ProtocolAddress
    final let storageDirectory: URL

    // Per-session stores (track state with this specific remote user)
    internal let identityStore: PersistentIdentityKeyStore
    private let sessionStore: SessionStore

    // Shared stores (all sessions share these - our pre-keys)
    private let preKeyStore: PreKeyStore
    private let signedPreKeyStore: SignedPreKeyStore
    private let kyberPreKeyStore: KyberPreKeyStore

    private let context = NullContext()

    /// Initialize session with shared stores
    /// - Parameters:
    ///   - localUser: The local user
    ///   - remoteUser: The remote user (nil for resumed sessions)
    ///   - protocolAddress: Remote user's protocol address
    ///   - storageId: Stable identifier for per-session storage (should be remoteUserId)
    ///   - sharedPreKeyStore: Shared pre-key store from plugin
    ///   - sharedSignedPreKeyStore: Shared signed pre-key store from plugin
    ///   - sharedKyberPreKeyStore: Shared Kyber pre-key store from plugin
    init(
        localUser: LocalUser,
        remoteUser: RemoteUser?,
        protocolAddress: ProtocolAddress,
        storageId: String,
        sharedPreKeyStore: PreKeyStore,
        sharedSignedPreKeyStore: SignedPreKeyStore,
        sharedKyberPreKeyStore: KyberPreKeyStore
    ) throws {
        self.localUser = localUser
        self.remoteUser = remoteUser
        self.remoteUserProtocolAddress = protocolAddress
        self.storageDirectory = EncryptedSession.getStorageDirectoryFor(remoteUserId: storageId)

        // Shared stores (pre-keys are ours, shared across all sessions)
        self.preKeyStore = sharedPreKeyStore
        self.signedPreKeyStore = sharedSignedPreKeyStore
        self.kyberPreKeyStore = sharedKyberPreKeyStore

        // Per-session stores (track state with this specific remote user)
        self.sessionStore = PersistentSessionStore(directoryURL: storageDirectory)
        self.identityStore = PersistentIdentityKeyStore(
            identityKeyPair: localUser.identityKey,
            registrationId: localUser.registrationId,
            directoryURL: storageDirectory
        )

        // Process remote user's preKey bundle if this is a new session
        if let remoteUser = remoteUser {
            try processRemoteBundle(remoteUser)
        }
    }

    private static func getStorageDirectoryFor(remoteUserId: String) -> URL {
        // Return a placeholder URL with remoteUserId as last path component
        // The stores now use Keychain and only need the last path component as prefix
        return URL(fileURLWithPath: remoteUserId)
    }

    public func encrypt(message: String) throws -> String {
        let messageBytes: [UInt8] = [UInt8](Data(message.utf8))
        let cipherTextMessage = try signalEncrypt(
            message: messageBytes,
            for: remoteUserProtocolAddress,
            sessionStore: sessionStore,
            identityStore: identityStore,
            context: context
        )
        // Serialize and encode the cipher text message
        let serializedMessage = cipherTextMessage.serialize()
        return Data(serializedMessage).base64EncodedString()
    }

    public func decrypt(message: String) throws -> String? {
        guard let messageData = Data(base64Encoded: message) else {
            throw SignalError.invalidMessage("Invalid base64 encoded message")
        }

        let messageBytes = [UInt8](messageData)
        var decryptedBytes: [UInt8]

        do {
            // Try to parse as a normal SignalMessage first (most common scenario)
            let signalMessage = try SignalMessage(bytes: [UInt8](messageData))
            decryptedBytes = [UInt8](try signalDecrypt(
                message: signalMessage,
                from: remoteUserProtocolAddress,
                sessionStore: sessionStore,
                identityStore: identityStore,
                context: context
            ))
        } catch {
            // If parsing or decrypting as SignalMessage fails, fall back to PreKeySignalMessage
            do {
                let preKeySignalMessage = try PreKeySignalMessage(bytes: messageBytes)
                decryptedBytes = [UInt8](try signalDecryptPreKey(
                    message: preKeySignalMessage,
                    from: remoteUserProtocolAddress,
                    sessionStore: sessionStore,
                    identityStore: identityStore,
                    preKeyStore: preKeyStore,
                    signedPreKeyStore: signedPreKeyStore,
                    kyberPreKeyStore: kyberPreKeyStore,
                    context: context
                ))
            } catch let preKeyError {
                // PreKey may have been consumed by a previous message in this batch.
                // The first PreKeySignalMessage establishes the session via signalDecryptPreKey,
                // but subsequent messages from the same sender (before they receive our reply)
                // still arrive as PreKeySignalMessages. Since the session is already established,
                // we can extract the inner SignalMessage and decrypt it with the existing session.
                do {
                    let reParsed = try PreKeySignalMessage(bytes: messageBytes)
                    let innerSignalMessage = reParsed.signalMessage
                    decryptedBytes = [UInt8](try signalDecrypt(
                        message: innerSignalMessage,
                        from: remoteUserProtocolAddress,
                        sessionStore: sessionStore,
                        identityStore: identityStore,
                        context: context
                    ))
                } catch {
                    throw preKeyError
                }
            }
        }

        return String(bytes: decryptedBytes, encoding: .utf8)
    }

    /// Process remote user's preKey bundle to establish session
    private func processRemoteBundle(_ remoteUser: RemoteUser) throws {
        let preKeyBundle = try PreKeyBundle(
            registrationId: remoteUser.registrationId,
            deviceId: remoteUser.protocolAddress.deviceId,
            prekeyId: remoteUser.preKeyId,
            prekey: remoteUser.preKeyPublicKey,
            signedPrekeyId: remoteUser.signedPreKeyId,
            signedPrekey: remoteUser.signedPreKeyPublicKey,
            signedPrekeySignature: remoteUser.signedPreKeySignature,
            identity: remoteUser.identityKeyPairPublicKey,
            kyberPrekeyId: remoteUser.kyberPreKeyId,
            kyberPrekey: remoteUser.kyberPreKeyPublicKey,
            kyberPrekeySignature: remoteUser.kyberPreKeySignature
        )

        try processPreKeyBundle(
            preKeyBundle,
            for: remoteUser.protocolAddress,
            sessionStore: sessionStore,
            identityStore: identityStore,
            context: context
        )
    }
}