//
//  PersistentSenderKeyStore.swift
//  Pods
//
//  Created by Claude Code on 07/01/26.
//
import Foundation
import LibSignalClient

class PersistentSenderKeyStore: SenderKeyStore {
    private let keyPrefix: String
    private let keychain = KeychainHelper.shared

    init(directoryURL: URL) {
        // Use the last path component as prefix for keychain keys
        self.keyPrefix = directoryURL.lastPathComponent
    }

    func storeSenderKey(
        from sender: ProtocolAddress,
        distributionId: UUID,
        record: SenderKeyRecord,
        context: StoreContext
    ) throws {
        let key = senderKeyKey(for: sender, distributionId: distributionId)
        let data = Data(record.serialize())
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist sender key state to Keychain")
        }
    }

    func loadSenderKey(
        from sender: ProtocolAddress,
        distributionId: UUID,
        context: StoreContext
    ) throws -> SenderKeyRecord? {
        let key = senderKeyKey(for: sender, distributionId: distributionId)
        guard let data = keychain.load(for: key) else {
            return nil
        }
        return try SenderKeyRecord(bytes: [UInt8](data))
    }

    private func senderKeyKey(for sender: ProtocolAddress, distributionId: UUID) -> String {
        return "senderKey-\(keyPrefix)-\(sender.name)-\(sender.deviceId)-\(distributionId.uuidString)"
    }

    func deleteAllSenderKeys(withPrefix prefix: String) {
        keychain.deleteAll(withPrefix: "senderKey-\(keyPrefix)-\(prefix)")
    }
}
