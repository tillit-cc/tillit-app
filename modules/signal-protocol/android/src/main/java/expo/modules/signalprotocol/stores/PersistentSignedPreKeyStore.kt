package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyStore

class PersistentSignedPreKeyStore(
    keyPrefix: String,  // ignored - signedPreKeys are global/local, not per-session
    context: Context
) : SignedPreKeyStore {
    // SignedPreKey is LOCAL, used by ANY remote user, so use fixed prefix
    private val keyPrefix = "local"
    private val keystore = KeystoreHelper.getInstance(context)

    override fun loadSignedPreKey(id: Int): SignedPreKeyRecord {
        val key = signedPreKeyKey(id)
        val data = keystore.load(key) ?: throw InvalidKeyIdException("No signed pre-key with id $id")
        return SignedPreKeyRecord(data)
    }

    override fun loadSignedPreKeys(): MutableList<SignedPreKeyRecord> {
        val prefix = "signedPreKey-$keyPrefix-"
        return keystore.getAllKeys()
            .filter { it.startsWith(prefix) }
            .mapNotNull { key ->
                keystore.load(key)?.let { SignedPreKeyRecord(it) }
            }
            .toMutableList()
    }

    override fun storeSignedPreKey(id: Int, record: SignedPreKeyRecord) {
        val key = signedPreKeyKey(id)
        val saved = keystore.save(key, record.serialize())
        if (!saved) {
            throw RuntimeException("Failed to persist signedPreKey to EncryptedSharedPreferences")
        }
    }

    override fun containsSignedPreKey(id: Int): Boolean {
        val key = signedPreKeyKey(id)
        return keystore.exists(key)
    }

    override fun removeSignedPreKey(id: Int) {
        val key = signedPreKeyKey(id)
        keystore.delete(key)
    }

    private fun signedPreKeyKey(id: Int): String {
        return "signedPreKey-$keyPrefix-$id"
    }
}
