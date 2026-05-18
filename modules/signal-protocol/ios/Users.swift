//
//  RemoteUser.swift
//  Pods
//
//  TilliT Native — Signal Protocol bindings
//


import Foundation
import LibSignalClient

struct RemoteUser {
    let preKeyId: UInt32
    let preKeyPublicKey: PublicKey
    let signedPreKeyId: UInt32
    let signedPreKeyPublicKey: PublicKey
    let signedPreKeySignature: Data
    let identityKeyPairPublicKey: IdentityKey
    let protocolAddress: ProtocolAddress
    let registrationId: UInt32
    let kyberPreKeyId: UInt32
    let kyberPreKeyPublicKey: KEMPublicKey
    let kyberPreKeySignature: Data

    init(
        preKeyId: UInt32,
        preKeyPublicKey: Data,
        signedPreKeyId: UInt32,
        signedPreKeyPublicKey: Data,
        signedPreKeySignature: Data,
        identityKeyPairPublicKey: Data,
        deviceId: UInt32,
        name: String,
        registrationId: UInt32,
        kyberPreKeyId: UInt32,
        kyberPreKeyPublicKey: Data,
        kyberPreKeySignature: Data
    ) throws {
        self.preKeyId = preKeyId
        self.preKeyPublicKey = try PublicKey(preKeyPublicKey)
        self.signedPreKeyId = signedPreKeyId
        self.signedPreKeyPublicKey = try PublicKey(signedPreKeyPublicKey)
        self.signedPreKeySignature = signedPreKeySignature
        self.identityKeyPairPublicKey = IdentityKey(publicKey: try PublicKey(identityKeyPairPublicKey))
        self.protocolAddress = try ProtocolAddress(name: name, deviceId: deviceId)
        self.registrationId = registrationId
        self.kyberPreKeyId = kyberPreKeyId
        self.kyberPreKeyPublicKey = try KEMPublicKey(kyberPreKeyPublicKey)
        self.kyberPreKeySignature = kyberPreKeySignature
    }
}

struct LocalUser {
    let identityKey: IdentityKeyPair
    let registrationId: UInt32
    let preKeys: [PreKeyRecord]
    let signedPreKey: SignedPreKeyRecord
    let kyberPreKeys: [KyberPreKeyRecord]
    let address: ProtocolAddress
    let deviceId: UInt32
    let name: String

    init(
        identityKey: IdentityKeyPair,
        registrationId: UInt32,
        preKeys: [PreKeyRecord],
        signedPreKey: SignedPreKeyRecord,
        kyberPreKeys: [KyberPreKeyRecord],
        deviceId: UInt32,
        name: String
    ) throws {
        self.identityKey = identityKey
        self.registrationId = registrationId
        self.preKeys = preKeys
        self.signedPreKey = signedPreKey
        self.kyberPreKeys = kyberPreKeys
        self.deviceId = deviceId
        self.name = name
        self.address = try ProtocolAddress(name: name, deviceId: deviceId)
    }
}
