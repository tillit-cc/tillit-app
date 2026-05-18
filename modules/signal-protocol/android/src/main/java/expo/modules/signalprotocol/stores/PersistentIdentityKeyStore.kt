package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.fingerprint.NumericFingerprintGenerator
import org.signal.libsignal.protocol.state.IdentityKeyStore
import java.security.MessageDigest

class PersistentIdentityKeyStore(
    private val identityKeyPair: IdentityKeyPair,
    private val registrationId: UInt,
    private val keyPrefix: String,
    context: Context
) : IdentityKeyStore {

    private val keystore = KeystoreHelper.getInstance(context)

    override fun getIdentityKeyPair(): IdentityKeyPair {
        return identityKeyPair
    }

    override fun getLocalRegistrationId(): Int {
        return registrationId.toInt()
    }

    override fun saveIdentity(address: SignalProtocolAddress, identityKey: IdentityKey): IdentityKeyStore.IdentityChange {
        val key = identityKeyKey(address)
        val existingIdentity = getIdentity(address)

        // SESSION CORRUPTION FIX: Throw error if save fails
        val saved = keystore.save(key, identityKey.serialize())
        if (!saved) {
            throw RuntimeException("Failed to persist identity to EncryptedSharedPreferences")
        }

        // Return REPLACED_EXISTING if identity replaced an existing different one
        if (existingIdentity != null && !existingIdentity.serialize().contentEquals(identityKey.serialize())) {
            return IdentityKeyStore.IdentityChange.REPLACED_EXISTING
        }
        return IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED
    }

    override fun isTrustedIdentity(address: SignalProtocolAddress, identityKey: IdentityKey, direction: IdentityKeyStore.Direction): Boolean {
        val savedIdentity = getIdentity(address)

        // TOFU (Trust On First Use): If no identity exists, trust it
        if (savedIdentity == null) {
            return true
        }

        // If the identity matches the saved one, trust it
        if (savedIdentity.serialize().contentEquals(identityKey.serialize())) {
            return true
        }

        // Identity key has changed! Block unless manually verified
        // This causes UntrustedIdentity (Error 12) which the JS layer handles via handleIdentityKeyChanged()
        return isManuallyTrusted(address, identityKey)
    }

    override fun getIdentity(address: SignalProtocolAddress): IdentityKey? {
        val key = identityKeyKey(address)
        val data = keystore.load(key) ?: return null
        return IdentityKey(ECPublicKey(data))
    }

    fun setManuallyTrusted(address: SignalProtocolAddress, identityKey: IdentityKey) {
        val key = trustKey(address, identityKey)
        keystore.save(key, "trusted".toByteArray())
    }

    fun isManuallyTrusted(address: SignalProtocolAddress, identityKey: IdentityKey): Boolean {
        val key = trustKey(address, identityKey)
        return keystore.exists(key)
    }

    /// Generate safety number using standard Signal Protocol NumericFingerprintGenerator
    fun generateSafetyNumber(localUserId: String, remoteAddress: SignalProtocolAddress, remoteIdentity: IdentityKey): String {
        val generator = NumericFingerprintGenerator(5200)
        val localIdentity = identityKeyPair.publicKey
        val fingerprint = generator.createFor(
            2,
            localUserId.toByteArray(Charsets.UTF_8),
            localIdentity,
            remoteAddress.name.toByteArray(Charsets.UTF_8),
            remoteIdentity
        )
        return fingerprint.displayableFingerprint.displayText
    }

    private fun identityKeyKey(address: SignalProtocolAddress): String {
        return "identity-$keyPrefix-${address.name}-${address.deviceId}"
    }

    private fun trustKey(address: SignalProtocolAddress, identityKey: IdentityKey): String {
        // M5 FIX: Use deterministic SHA256 instead of contentHashCode()
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(identityKey.serialize())
        val hashString = hash.take(8).joinToString("") { "%02x".format(it) }
        return "trust-$keyPrefix-${address.name}-${address.deviceId}-$hashString"
    }

}
