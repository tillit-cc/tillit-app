package expo.modules.signalprotocol

import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.kem.KEMPublicKey

open class RemoteUser(
    val preKeyId: Int,
    preKeyPublicKey: ByteArray,
    val signedPreKeyId: Int,
    signedPreKeyPublicKey: ByteArray,
    val signedPreKeySignature: ByteArray,
    identityKeyPairPublicKey: ByteArray,
    deviceId: Int,
    name: String,
    val registrationId: Int,
    val kyberPreKeyId: Int,
    kyberPreKeyPublicKey: ByteArray,
    val kyberPreKeySignature: ByteArray
) {
    val preKeyPublicKey = ECPublicKey(preKeyPublicKey)
    val signedPreKeyPublicKey = ECPublicKey(signedPreKeyPublicKey)
    val identityKeyPairPublicKey = IdentityKey(ECPublicKey(identityKeyPairPublicKey))
    val protocolAddress = SignalProtocolAddress(name, deviceId)
    val kyberPreKeyPublicKey = KEMPublicKey(kyberPreKeyPublicKey)
}
