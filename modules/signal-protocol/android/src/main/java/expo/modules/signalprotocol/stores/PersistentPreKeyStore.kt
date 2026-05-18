package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyStore

class PersistentPreKeyStore(
    keyPrefix: String,  // ignored - preKeys are global/local, not per-session
    context: Context
) : PreKeyStore {
    // PreKeys are LOCAL keys used by ANY remote user, so use fixed prefix
    private val keyPrefix = "local"
    private val keystore = KeystoreHelper.getInstance(context)

    override fun loadPreKey(id: Int): PreKeyRecord {
        val key = preKeyKey(id)
        val data = keystore.load(key) ?: throw InvalidKeyIdException("No pre-key with id $id")
        return PreKeyRecord(data)
    }

    override fun storePreKey(id: Int, record: PreKeyRecord) {
        val key = preKeyKey(id)
        val saved = keystore.save(key, record.serialize())
        if (!saved) {
            throw RuntimeException("Failed to persist preKey to EncryptedSharedPreferences")
        }
    }

    override fun containsPreKey(id: Int): Boolean {
        val key = preKeyKey(id)
        return keystore.exists(key)
    }

    override fun removePreKey(id: Int) {
        val key = preKeyKey(id)
        keystore.delete(key)
    }

    private fun preKeyKey(id: Int): String {
        return "preKey-$keyPrefix-$id"
    }
}
