package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord
import org.signal.libsignal.protocol.groups.state.SenderKeyStore
import java.util.UUID

class PersistentSenderKeyStore(
    private val keyPrefix: String,
    context: Context
) : SenderKeyStore {

    private val keystore = KeystoreHelper.getInstance(context)

    override fun storeSenderKey(
        sender: SignalProtocolAddress,
        distributionId: UUID,
        record: SenderKeyRecord
    ) {
        val key = senderKeyKey(sender, distributionId)
        val saved = keystore.save(key, record.serialize())
        if (!saved) {
            throw RuntimeException("Failed to persist senderKey to EncryptedSharedPreferences")
        }
    }

    override fun loadSenderKey(
        sender: SignalProtocolAddress,
        distributionId: UUID
    ): SenderKeyRecord? {
        val key = senderKeyKey(sender, distributionId)
        val data = keystore.load(key) ?: return null
        return SenderKeyRecord(data)
    }

    private fun senderKeyKey(sender: SignalProtocolAddress, distributionId: UUID): String {
        return "senderKey-$keyPrefix-${sender.name}-${sender.deviceId}-$distributionId"
    }

    fun deleteAllSenderKeys(prefix: String) {
        keystore.deleteAll("senderKey-$keyPrefix-$prefix")
    }
}
