//
//  SessionStore.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//
import Foundation
import LibSignalClient

class PersistentSessionStore: SessionStore {
    private let keyPrefix: String
    private let keychain = KeychainHelper.shared

    init(directoryURL: URL) {
        // Use the last path component as prefix for keychain keys
        self.keyPrefix = directoryURL.lastPathComponent
    }

    func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
        let key = sessionKey(for: address)
        guard let data = keychain.load(for: key) else {
            return nil
        }
        return try SessionRecord(bytes: [UInt8](data))
    }

    func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
        return try addresses.compactMap { try loadSession(for: $0, context: context) }
    }

    func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws {
        let key = sessionKey(for: address)
        let data = Data(record.serialize())

        // SESSION CORRUPTION FIX: Throw error if save fails
        // This ensures the message won't be marked as SENT if session state isn't persisted
        // The caller (chat.service.ts) will keep the message in queue for retry
        let saved = keychain.save(data: data, for: key)
        if !saved {
            throw SignalError.internalError("Failed to persist session state to Keychain")
        }
    }

    private func sessionKey(for address: ProtocolAddress) -> String {
        return "session-\(keyPrefix)-\(address.name)-\(address.deviceId)"
    }
}
