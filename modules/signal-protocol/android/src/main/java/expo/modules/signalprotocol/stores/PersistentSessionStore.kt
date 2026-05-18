package expo.modules.signalprotocol.stores

import android.content.Context
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SessionStore

class PersistentSessionStore(
    private val keyPrefix: String,
    context: Context
) : SessionStore {

    private val keystore = KeystoreHelper.getInstance(context)

    override fun loadSession(forAddress: SignalProtocolAddress): SessionRecord? {
        val key = sessionKey(forAddress)
        val data = keystore.load(key) ?: return null
        return SessionRecord(data)
    }

    override fun loadExistingSessions(forAddresses: List<SignalProtocolAddress>): List<SessionRecord> {
        val sessions = mutableListOf<SessionRecord>()
        for (address in forAddresses) {
            val session = loadSession(address)
                ?: throw NoSessionException("No session for $address")
            sessions.add(session)
        }
        return sessions
    }

    override fun getSubDeviceSessions(name: String?): MutableList<Int> {
        return mutableListOf()
    }

    override fun storeSession(address: SignalProtocolAddress?, record: SessionRecord?) {
        if (address != null && record != null) {
            val key = sessionKey(address)
            // SESSION CORRUPTION FIX: Throw error if save fails
            val saved = keystore.save(key, record.serialize())
            if (!saved) {
                throw RuntimeException("Failed to persist session state to EncryptedSharedPreferences")
            }
        }
    }

    override fun containsSession(forAddress: SignalProtocolAddress): Boolean {
        val key = sessionKey(forAddress)
        return keystore.exists(key)
    }

    override fun deleteSession(forAddress: SignalProtocolAddress) {
        val key = sessionKey(forAddress)
        keystore.delete(key)
    }

    override fun deleteAllSessions(name: String) {
        val prefix = "session-$keyPrefix-$name"
        keystore.deleteAll(prefix)
    }

    private fun sessionKey(address: SignalProtocolAddress): String {
        return "session-$keyPrefix-${address.name}-${address.deviceId}"
    }
}
