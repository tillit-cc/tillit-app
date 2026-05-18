//
//  PersistentSignedPreKeyStore.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//
import Foundation
import LibSignalClient

class PersistentSignedPreKeyStore: SignedPreKeyStore {
    // SignedPreKey is LOCAL, used by ANY remote user, so use fixed prefix
    private let keyPrefix = "local"
    private let keychain = KeychainHelper.shared

    init(directoryURL: URL) {
        // directoryURL is ignored - signedPreKeys are global/local, not per-session
    }

    func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
        let key = signedPreKeyKey(for: id)
        guard let data = keychain.load(for: key) else {
            throw SignalError.invalidKey("No signed pre-key with id \(id)")
        }
        return try SignedPreKeyRecord(bytes: [UInt8](data))
    }

    func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws {
        let key = signedPreKeyKey(for: id)
        let data = Data(record.serialize())
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist signedPreKey to Keychain")
        }
    }

    private func signedPreKeyKey(for id: UInt32) -> String {
        return "signedPreKey-\(keyPrefix)-\(id)"
    }
}
