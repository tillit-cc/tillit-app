//
//  PersistentPreKeyStore.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//
import Foundation
import LibSignalClient

class PersistentPreKeyStore: PreKeyStore {
    // PreKeys are LOCAL keys used by ANY remote user, so use fixed prefix
    private let keyPrefix = "local"
    private let keychain = KeychainHelper.shared

    init(directoryURL: URL) {
        // directoryURL is ignored - preKeys are global/local, not per-session
    }

    func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
        let key = preKeyKey(for: id)
        guard let data = keychain.load(for: key) else {
            throw SignalError.invalidKey("No pre-key with id \(id)")
        }
        return try PreKeyRecord(bytes: [UInt8](data))
    }

    func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
        let key = preKeyKey(for: id)
        let data = Data(record.serialize())
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist preKey to Keychain")
        }
    }

    func removePreKey(id: UInt32, context: StoreContext) throws {
        let key = preKeyKey(for: id)
        keychain.delete(for: key)
    }

    private func preKeyKey(for id: UInt32) -> String {
        return "preKey-\(keyPrefix)-\(id)"
    }
}
