//
//  KeyGeneration.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//


import Foundation
import LibSignalClient

struct KeyGeneration {
    static let maxVal: UInt32 = 16777215
    static let maxPreKeys = 100
    static let registrationIdMask: UInt32 = 0x3FFF

    static func generateIdentityKeyPair() -> IdentityKeyPair {
        return IdentityKeyPair.generate()
    }

    static func generateRegistrationId() -> UInt32 {
        return UInt32.random(in: 0...registrationIdMask)
    }

    static func generateSignedPreKey(identityKeyPair: IdentityKeyPair, signedPreKeyId: UInt32) throws -> SignedPreKeyRecord {
        let privateKey = PrivateKey.generate()
        let signature = identityKeyPair.privateKey.generateSignature(message: privateKey.publicKey.serialize())
        return try SignedPreKeyRecord(
            id: signedPreKeyId,
            timestamp: UInt64(Date().timeIntervalSince1970),
            privateKey: privateKey,
            signature: signature
        )
    }

    static func generatePreKeys(start: UInt32, count: UInt32) throws -> [PreKeyRecord] {
        var results = [PreKeyRecord]()
        for i in 0..<count {
            let id = ((start + i) % (maxVal - 1)) + 1
            let privateKey = PrivateKey.generate()
            let publicKey = privateKey.publicKey
            results.append(try PreKeyRecord(id: id, publicKey: publicKey, privateKey: privateKey))
        }
        return results
    }
    
    static func generateKyberPreKeys(startId: UInt32, count: UInt32, identityKeyPair: IdentityKeyPair) throws -> [KyberPreKeyRecord] {
        var kyberPreKeys = [KyberPreKeyRecord]()
        for i in 0..<count {
            let id = ((startId + i) % (maxVal - 1)) + 1
            let keyPair = KEMKeyPair.generate()
            let publicKey = keyPair.publicKey
            let signature = try signKyberPreKey(
                kyberPublicKey: publicKey,
                identityKeyPair: identityKeyPair
            )
            let timestamp = UInt64(Date().timeIntervalSince1970)
            let kyberPreKey = try KyberPreKeyRecord(
                id: id,
                timestamp: timestamp,
                keyPair: keyPair,
                signature: signature
            )
            kyberPreKeys.append(kyberPreKey)
        }
        return kyberPreKeys
    }
    
    static func signKyberPreKey(kyberPublicKey: KEMPublicKey, identityKeyPair: IdentityKeyPair) throws -> Data {
        let message = kyberPublicKey.serialize()
        return identityKeyPair.privateKey.generateSignature(message: message)
    }

    static func generateKeys(existingIdentity: IdentityKeyPair? = nil) throws -> Registration {
        // Multi-device pairing: when an existing identity is provided (linked
        // device import), reuse it instead of generating a fresh one. All the
        // other keys (registration id, signed pre-key, pre-keys, kyber
        // pre-keys) are still generated fresh per-device — only the user-level
        // identity is shared across devices of the same user.
        let identityKeyPair = existingIdentity ?? generateIdentityKeyPair()
        let registrationId = generateRegistrationId()
        let signedPreKeyId = UInt32.random(in: 1...maxVal - 1)
        let signedPreKey = try generateSignedPreKey(identityKeyPair: identityKeyPair, signedPreKeyId: signedPreKeyId)
        let start = UInt32.random(in: 1...maxVal - UInt32(maxPreKeys) - 1)
        let preKeys = try generatePreKeys(start: start, count: UInt32(maxPreKeys))
        let kyberPreKeys = try generateKyberPreKeys(startId: start + UInt32(maxPreKeys), count: UInt32(maxPreKeys), identityKeyPair: identityKeyPair)

        return Registration(
            identityKeyPair: identityKeyPair,
            registrationId: registrationId,
            preKeys: preKeys,
            signedPreKeyRecord: signedPreKey,
            kyberPreKeys: kyberPreKeys
        )
    }
}
