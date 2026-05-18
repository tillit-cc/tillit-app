package expo.modules.signalprotocol

import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord

class Registration(
    val identityKeyPair: IdentityKeyPair,
    val registrationId: Int,
    val preKeys: List<PreKeyRecord>,
    val kyberPreKeys: List<KyberPreKeyRecord>,
    val signedPreKeyRecord: SignedPreKeyRecord
) {
    fun identityKeyPublicBase64(): String {
        return android.util.Base64.encodeToString(identityKeyPair.publicKey.serialize(), android.util.Base64.NO_WRAP)
    }

    fun identityKeyPairBase64(): String {
        return android.util.Base64.encodeToString(identityKeyPair.serialize(), android.util.Base64.NO_WRAP)
    }

    fun signedPreKeyRecordBase64(): String {
        return android.util.Base64.encodeToString(signedPreKeyRecord.serialize(), android.util.Base64.NO_WRAP)
    }

    fun signedPreKeyPublicKeyBase64(): String {
        return try {
            android.util.Base64.encodeToString(signedPreKeyRecord.keyPair.publicKey.serialize(), android.util.Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    fun signedPreKeyId(): UInt {
        return signedPreKeyRecord.id.toUInt()
    }

    fun signedPreKeyRecordSignatureBase64(): String {
        return android.util.Base64.encodeToString(signedPreKeyRecord.signature, android.util.Base64.NO_WRAP)
    }
}
