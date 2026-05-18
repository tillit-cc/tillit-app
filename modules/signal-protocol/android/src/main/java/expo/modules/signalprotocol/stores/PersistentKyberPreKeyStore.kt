package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.ReusedBaseKeyException
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.KyberPreKeyStore

class PersistentKyberPreKeyStore(
    keyPrefix: String,  // ignored - kyberPreKeys are global/local, not per-session
    context: Context
) : KyberPreKeyStore {
    // KyberPreKeys are LOCAL, used by ANY remote user, so use fixed prefix
    private val keyPrefix = "local"
    private val keystore = KeystoreHelper.getInstance(context)

    override fun loadKyberPreKey(id: Int): KyberPreKeyRecord {
        val key = kyberPreKeyKey(id)
        val data = keystore.load(key) ?: throw InvalidKeyIdException("No kyber pre-key with id $id")
        return KyberPreKeyRecord(data)
    }

    override fun loadKyberPreKeys(): MutableList<KyberPreKeyRecord> {
        val prefix = "kyberPreKey-$keyPrefix-"
        return keystore.getAllKeys()
            .filter { it.startsWith(prefix) }
            .mapNotNull { key ->
                keystore.load(key)?.let { KyberPreKeyRecord(it) }
            }
            .toMutableList()
    }

    override fun storeKyberPreKey(id: Int, record: KyberPreKeyRecord) {
        val key = kyberPreKeyKey(id)
        val saved = keystore.save(key, record.serialize())
        if (!saved) {
            throw RuntimeException("Failed to persist kyberPreKey to EncryptedSharedPreferences")
        }
    }

    override fun containsKyberPreKey(id: Int): Boolean {
        val key = kyberPreKeyKey(id)
        return keystore.exists(key)
    }

    override fun markKyberPreKeyUsed(kyberPreKeyId: Int, messageId: Int, baseKey: ECPublicKey) {
        val usedKey = kyberPreKeyUsedKey(kyberPreKeyId)
        val previousBaseKey = keystore.load(usedKey)

        if (previousBaseKey != null) {
            // This pre-key was already used — check if same baseKey (retry) or different (replay attack)
            if (!previousBaseKey.contentEquals(baseKey.serialize())) {
                throw ReusedBaseKeyException("Kyber pre-key $kyberPreKeyId reused with different base key")
            }
            // Same baseKey = legitimate retry, allow it
            return
        }

        // Record which baseKey consumed this pre-key, then delete the pre-key
        keystore.save(usedKey, baseKey.serialize())
        val key = kyberPreKeyKey(kyberPreKeyId)
        keystore.delete(key)
    }

    private fun kyberPreKeyKey(id: Int): String {
        return "kyberPreKey-$keyPrefix-$id"
    }

    private fun kyberPreKeyUsedKey(id: Int): String {
        return "kyberPreKeyUsed-$keyPrefix-$id"
    }
}
