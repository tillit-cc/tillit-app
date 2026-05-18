package expo.modules.signalprotocol

import android.content.Context
import expo.modules.signalprotocol.stores.*
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyStore
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyStore
import org.signal.libsignal.protocol.state.SessionStore
import org.signal.libsignal.protocol.state.SignedPreKeyStore

/**
 * EncryptedSession - Manages encrypted communication with a remote user.
 *
 * Uses shared stores for pre-keys (H6/H7 fix) so that all sessions see
 * new pre-keys immediately after replenishment/rotation.
 *
 * @param localUser The local user's identity and keys
 * @param remoteAddress The remote user's Signal protocol address
 * @param remoteUser The remote user's public keys (null when resuming existing session)
 * @param storageId Stable identifier for per-session storage (should be remoteUserId)
 * @param sharedPreKeyStore Shared pre-key store from plugin
 * @param sharedSignedPreKeyStore Shared signed pre-key store from plugin
 * @param sharedKyberPreKeyStore Shared Kyber pre-key store from plugin
 * @param androidContext Android context for storage access
 */
class EncryptedSession(
    private val localUser: LocalUser,
    val remoteAddress: SignalProtocolAddress,
    private val remoteUser: RemoteUser?,
    private val storageId: String,
    private val sharedPreKeyStore: PreKeyStore,
    private val sharedSignedPreKeyStore: SignedPreKeyStore,
    private val sharedKyberPreKeyStore: KyberPreKeyStore,
    androidContext: Context
) {
    // Per-session stores (track state with this specific remote user)
    internal val identityStore: PersistentIdentityKeyStore
    private val sessionStore: SessionStore

    // Shared stores (all sessions share these - our pre-keys)
    private val preKeyStore: PreKeyStore = sharedPreKeyStore
    private val signedPreKeyStore: SignedPreKeyStore = sharedSignedPreKeyStore
    private val kyberPreKeyStore: KyberPreKeyStore = sharedKyberPreKeyStore

    init {
        // Use storageId (remoteUserId) as keyPrefix for per-session stores
        val keyPrefix = storageId
        identityStore = PersistentIdentityKeyStore(localUser.identityKey, localUser.registrationId, keyPrefix, androidContext)
        sessionStore = PersistentSessionStore(keyPrefix, androidContext)

        // Process remote user's preKey bundle if this is a new session
        if (remoteUser != null) {
            processRemoteBundle(remoteUser)
        }
    }

    private fun processRemoteBundle(remoteUser: RemoteUser) {
        val preKeyBundle = PreKeyBundle(
            remoteUser.registrationId,
            remoteAddress.deviceId,
            remoteUser.preKeyId,
            remoteUser.preKeyPublicKey,
            remoteUser.signedPreKeyId,
            remoteUser.signedPreKeyPublicKey,
            remoteUser.signedPreKeySignature,
            remoteUser.identityKeyPairPublicKey,
            remoteUser.kyberPreKeyId,
            remoteUser.kyberPreKeyPublicKey,
            remoteUser.kyberPreKeySignature
        )

        val sessionBuilder = SessionBuilder(
            sessionStore, preKeyStore, signedPreKeyStore, identityStore, remoteAddress
        )
        sessionBuilder.process(preKeyBundle)
    }

    fun encrypt(message: String): String {
        val messageBytes = message.toByteArray(Charsets.UTF_8)
        val sessionCipher = SessionCipher(sessionStore, preKeyStore, signedPreKeyStore, kyberPreKeyStore, identityStore, remoteAddress)
        val cipherTextMessage = sessionCipher.encrypt(messageBytes)
        return android.util.Base64.encodeToString(cipherTextMessage.serialize(), android.util.Base64.NO_WRAP)
    }

    fun decrypt(encryptedMessage: String): String? {
        val messageData = android.util.Base64.decode(encryptedMessage, android.util.Base64.NO_WRAP)
        val sessionCipher = SessionCipher(sessionStore, preKeyStore, signedPreKeyStore, kyberPreKeyStore, identityStore, remoteAddress)
        return try {
            val signalMsg = SignalMessage(messageData)
            val decrypted = sessionCipher.decrypt(signalMsg)
            String(decrypted, Charsets.UTF_8)
        } catch (e: Exception) {
            val preKeySignalMsg = PreKeySignalMessage(messageData)
            try {
                val decrypted = sessionCipher.decrypt(preKeySignalMsg)
                String(decrypted, Charsets.UTF_8)
            } catch (preKeyError: Exception) {
                // PreKey may have been consumed by a previous message in this batch.
                // The first PreKeySignalMessage establishes the session via decrypt(PreKeySignalMessage),
                // but subsequent messages from the same sender (before they receive our reply)
                // still arrive as PreKeySignalMessages. Since the session is already established,
                // we can extract the inner SignalMessage and decrypt it with the existing session.
                val innerSignalMsg = preKeySignalMsg.getWhisperMessage()
                val decrypted = sessionCipher.decrypt(innerSignalMsg)
                String(decrypted, Charsets.UTF_8)
            }
        }
    }
}
