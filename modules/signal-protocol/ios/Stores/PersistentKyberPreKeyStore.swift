//
//  PersistentKyberPreKeyStore.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//


import Foundation
import LibSignalClient

class PersistentKyberPreKeyStore: KyberPreKeyStore {
    // KyberPreKeys are LOCAL, used by ANY remote user, so use fixed prefix
    private let keyPrefix = "local"
    private let keychain = KeychainHelper.shared

    init(directoryURL: URL) {
        // directoryURL is ignored - kyberPreKeys are global/local, not per-session
    }

    func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
        let key = kyberPreKeyKey(for: id)
        guard let data = keychain.load(for: key) else {
            throw SignalError.invalidKey("No Kyber pre-key with id \(id)")
        }
        return try KyberPreKeyRecord(bytes: [UInt8](data))
    }

    func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
        let key = kyberPreKeyKey(for: id)
        let data = Data(record.serialize())
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist kyberPreKey to Keychain")
        }
    }

    func markKyberPreKeyUsed(id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: any StoreContext) throws {
        // Mark the Kyber pre-key as used
        let key = usedKyberPreKeyKey(for: id)

        // Store metadata about the usage
        let metadata: [String: Any] = [
            "kyberPreKeyId": id,
            "signedPreKeyId": signedPreKeyId,
            "baseKeyData": Data(baseKey.serialize()).base64EncodedString(),
            "timestamp": Date().timeIntervalSince1970
        ]

        let data = try JSONSerialization.data(withJSONObject: metadata, options: [])
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist kyberPreKey usage to Keychain")
        }
    }

    private func kyberPreKeyKey(for id: UInt32) -> String {
        return "kyberPreKey-\(keyPrefix)-\(id)"
    }

    private func usedKyberPreKeyKey(for id: UInt32) -> String {
        return "usedKyberPreKey-\(keyPrefix)-\(id)"
    }
}
