//
//  Registration.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//


import Foundation
import LibSignalClient

struct Registration {
    let identityKeyPair: IdentityKeyPair
    let registrationId: UInt32
    let preKeys: [PreKeyRecord]
    let signedPreKeyRecord: SignedPreKeyRecord
    let kyberPreKeys: [KyberPreKeyRecord]

    init(identityKeyPair: IdentityKeyPair, registrationId: UInt32, preKeys: [PreKeyRecord], signedPreKeyRecord: SignedPreKeyRecord, kyberPreKeys: [KyberPreKeyRecord]) {
        self.identityKeyPair = identityKeyPair
        self.registrationId = registrationId
        self.preKeys = preKeys
        self.signedPreKeyRecord = signedPreKeyRecord
        self.kyberPreKeys = kyberPreKeys
    }

    // Serialization and utility methods
    func identityKeyPairBase64() -> String {
        return Data(identityKeyPair.serialize()).base64EncodedString()
    }

    func identityKeyPublicBase64() -> String {
        return Data(identityKeyPair.publicKey.serialize()).base64EncodedString()
    }

    func preKeyIdsBase64() -> [String] {
        return preKeys.map { preKeyRecord in
            Data(preKeyRecord.serialize()).base64EncodedString()
        }
    }

    func signedPreKeyRecordBase64() -> String {
        return Data(signedPreKeyRecord.serialize()).base64EncodedString()
    }

    func signedPreKeyPublicKeyBase64() -> String {
        do {
            return try Data(signedPreKeyRecord.publicKey().serialize()).base64EncodedString()
        } catch {
            return ""
        }
    }

    func signedPreKeyId() -> UInt32 {
        return signedPreKeyRecord.id
    }

    func signedPreKeyRecordSignatureBase64() -> String {
        return Data(signedPreKeyRecord.signature).base64EncodedString()
    }
    
    func kyberPreKeysBase64() -> [String] {
        return kyberPreKeys.map { kyberPreKeyRecord in
            Data(kyberPreKeyRecord.serialize()).base64EncodedString()
        }
    }
}
