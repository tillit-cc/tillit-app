package expo.modules.signalprotocol

import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import java.security.SecureRandom

object KeyGeneration {
    const val MAX_VAL: Int = 16777215
    private const val MAX_PRE_KEYS = 100
    private const val REGISTRATION_ID_MASK: Int = 16383
    private val secureRandom = SecureRandom()

    private fun generateIdentityKeyPair(): IdentityKeyPair {
        return IdentityKeyPair.generate()
    }

    private fun generateRegistrationId(): Int {
        return secureRandom.nextInt(REGISTRATION_ID_MASK)
    }

    fun generateSignedPreKey(identityKeyPair: IdentityKeyPair, signedPreKeyId: Int): SignedPreKeyRecord {
        val keyPair = ECKeyPair.generate()
        val signature = identityKeyPair.privateKey.calculateSignature(keyPair.publicKey.serialize())
        return SignedPreKeyRecord(
            signedPreKeyId,
            System.currentTimeMillis(),
            keyPair,
            signature
        )
    }

    fun generatePreKeys(start: Int, count: Int): List<PreKeyRecord> {
        val results = mutableListOf<PreKeyRecord>()
        for (i in 0 until count) {
            val id = ((start + i) % (MAX_VAL - 1)) + 1
            val keyPair = ECKeyPair.generate()
            results.add(PreKeyRecord(id, keyPair))
        }
        return results
    }

    fun generateKyberPreKeys(start: Int, count: Int, identityKeyPair: IdentityKeyPair): List<KyberPreKeyRecord> {
        val results = mutableListOf<KyberPreKeyRecord>()
        for (i in 0 until count) {
            val id = ((start + i) % (MAX_VAL - 1)) + 1
            val kemKeyPair = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
            val signature = identityKeyPair.privateKey.calculateSignature(kemKeyPair.publicKey.serialize())
            val timestamp = System.currentTimeMillis()
            results.add(KyberPreKeyRecord(id, timestamp, kemKeyPair, signature))
        }
        return results
    }

    fun generateKeys(): Registration {
        val identityKeyPair = generateIdentityKeyPair()
        val registrationId = generateRegistrationId()
        val signedPreKeyId = secureRandom.nextInt(MAX_VAL - 2) + 1
        val signedPreKey = generateSignedPreKey(identityKeyPair, signedPreKeyId)
        val start = secureRandom.nextInt(MAX_VAL - MAX_PRE_KEYS - 2) + 1
        val preKeys = generatePreKeys(start, MAX_PRE_KEYS)
        val kyberPreKeys = generateKyberPreKeys(start, MAX_PRE_KEYS, identityKeyPair)

        return Registration(
            identityKeyPair = identityKeyPair,
            registrationId = registrationId,
            preKeys = preKeys,
            kyberPreKeys = kyberPreKeys,
            signedPreKeyRecord = signedPreKey
        )
    }
}
