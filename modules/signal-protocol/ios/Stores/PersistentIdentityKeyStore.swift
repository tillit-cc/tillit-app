//
//  PersistentIdentityKeyStore.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//
import Foundation
import LibSignalClient
import CryptoKit

class PersistentIdentityKeyStore: IdentityKeyStore {

    private let identityKeyPair: IdentityKeyPair
    private let registrationId: UInt32
    private let keyPrefix: String
    private let keychain = KeychainHelper.shared

    init(identityKeyPair: IdentityKeyPair, registrationId: UInt32, directoryURL: URL) {
        self.identityKeyPair = identityKeyPair
        self.registrationId = registrationId
        // Use the last path component as prefix for keychain keys
        self.keyPrefix = directoryURL.lastPathComponent
    }

    func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
        return identityKeyPair
    }

    func localRegistrationId(context: StoreContext) throws -> UInt32 {
        return registrationId
    }

    func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws -> IdentityChange {
        let key = identityKeyKey(for: address)
        let existingIdentity = try? self.identity(for: address, context: context)

        let data = Data(identity.serialize())
        let saved = keychain.save(data: data, for: key)

        // SESSION CORRUPTION FIX: Throw error if save fails
        if !saved {
            throw SignalError.internalError("Failed to persist identity to Keychain")
        }

        if let existing = existingIdentity {
            return existing.serialize() == identity.serialize() ? .newOrUnchanged : .replacedExisting
        }
        return .newOrUnchanged
    }

    func isTrustedIdentity(_ identity: IdentityKey, for address: ProtocolAddress, direction: Direction, context: StoreContext) throws -> Bool {
        let savedIdentity = try? self.identity(for: address, context: context)

        // TOFU (Trust On First Use): If no identity exists, trust it
        guard let savedIdentity = savedIdentity else {
            return true
        }

        // If the identity matches the saved one, trust it
        if savedIdentity.serialize() == identity.serialize() {
            return true
        }

        // For both RECEIVING and SENDING, block unless manually verified
        // This causes UntrustedIdentity (Error 12) which the JS layer handles via handleIdentityKeyChanged()
        return isManuallyTrusted(identity, for: address)
    }

    func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
        let key = identityKeyKey(for: address)
        guard let data = keychain.load(for: key) else {
            return nil
        }
        return try IdentityKey(publicKey: PublicKey([UInt8](data)))
    }

    /// Mark an identity key as manually trusted (e.g., after out-of-band verification)
    func setManuallyTrusted(_ identity: IdentityKey, for address: ProtocolAddress) throws {
        let key = trustKey(for: address, identity: identity)
        let data = Data("trusted".utf8)
        _ = keychain.save(data: data, for: key)
    }

    /// Check if an identity key was manually verified by the user
    func isManuallyTrusted(_ identity: IdentityKey, for address: ProtocolAddress) -> Bool {
        let key = trustKey(for: address, identity: identity)
        return keychain.exists(for: key)
    }

    /// Generate safety number using standard Signal Protocol NumericFingerprintGenerator
    func generateSafetyNumber(localUserId: String, for remoteAddress: ProtocolAddress, remoteIdentity: IdentityKey) throws -> String {
        let generator = NumericFingerprintGenerator(iterations: 5200)
        let localKey = identityKeyPair.publicKey   // IdentityKeyPair.publicKey → PublicKey
        let remoteKey = remoteIdentity.publicKey   // IdentityKey.publicKey → PublicKey
        let fingerprint = try generator.create(
            version: 2,
            localIdentifier: Data(localUserId.utf8),
            localKey: localKey,
            remoteIdentifier: Data(remoteAddress.name.utf8),
            remoteKey: remoteKey
        )
        return fingerprint.displayable.formatted
    }

    private func identityKeyKey(for address: ProtocolAddress) -> String {
        return "identity-\(keyPrefix)-\(address.name)-\(address.deviceId)"
    }

    private func trustKey(for address: ProtocolAddress, identity: IdentityKey) -> String {
        // M5 FIX: Use deterministic SHA256 instead of randomized hashValue
        // hashValue in Swift is randomized per app execution, causing trust state to be lost on restart
        let serialized = identity.serialize()
        let hash = SHA256.hash(data: Data(serialized))
        // Use first 8 bytes (16 hex characters) for reasonable key length
        let hashString = hash.prefix(8).map { String(format: "%02x", $0) }.joined()
        return "trust-\(keyPrefix)-\(address.name)-\(address.deviceId)-\(hashString)"
    }
}
