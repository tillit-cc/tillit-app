package expo.modules.signalprotocol

import android.util.Base64
import android.util.Log
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.signalprotocol.stores.KeystoreHelper
import expo.modules.signalprotocol.stores.PersistentKyberPreKeyStore
import expo.modules.signalprotocol.stores.PersistentPreKeyStore
import expo.modules.signalprotocol.stores.PersistentSenderKeyStore
import expo.modules.signalprotocol.stores.PersistentSignedPreKeyStore
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.groups.GroupCipher
import org.signal.libsignal.protocol.groups.GroupSessionBuilder
import org.signal.libsignal.protocol.message.SenderKeyDistributionMessage
import org.signal.libsignal.protocol.ecc.ECPrivateKey
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.kdf.HKDF
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class SignalProtocolModule : Module() {
    private var localUser: LocalUser? = null
    // M-10 FIX: ConcurrentHashMap for defensive thread safety.
    //
    // Multi-device (ADR-0001 D4): the map is keyed by `(userId, deviceId)`
    // so we hold a distinct session per peer device. Encoding is
    // `"<userId>/<deviceId>"`. Use `sessionKey()` to compose, and
    // `getEncryptedSession()` / `putEncryptedSession()` / `removeEncryptedSession()`
    // for type-safe access. The legacy `encryptedSessions[userId]` access
    // pattern is gone — every call site must now know the deviceId
    // (default 1 for backward-compat with single-device peers).
    private val encryptedSessions = java.util.concurrent.ConcurrentHashMap<String, EncryptedSession>()
    private fun sessionKey(userId: String, deviceId: Int = 1): String = "$userId/$deviceId"
    private fun getEncryptedSession(userId: String, deviceId: Int = 1): EncryptedSession? =
        encryptedSessions[sessionKey(userId, deviceId)]
    private fun putEncryptedSession(userId: String, deviceId: Int = 1, session: EncryptedSession) {
        encryptedSessions[sessionKey(userId, deviceId)] = session
    }
    private fun removeEncryptedSession(userId: String, deviceId: Int) {
        encryptedSessions.remove(sessionKey(userId, deviceId))
    }
    private var senderKeyStore: PersistentSenderKeyStore? = null

    // H6/H7 FIX: Shared stores for pre-keys (all sessions share these)
    private var sharedPreKeyStore: PersistentPreKeyStore? = null
    private var sharedSignedPreKeyStore: PersistentSignedPreKeyStore? = null
    private var sharedKyberPreKeyStore: PersistentKyberPreKeyStore? = null

    // Keys for storing identity key pair in protected storage
    private val identityKeyPairStorageKey = "local-identity-key-pair"
    private val localUserMetadataStorageKey = "local-user-metadata"

    private val context get() = appContext.reactContext!!

    // Shared identity-setup path used both by `initializeIdentity` (fresh
    // install or explicit import) and by `consumeProvisioningPayload`
    // (multi-device pairing — the linked device receives the primary's
    // identity inside the decrypted payload and never exposes it to JS).
    // When `importedIdentity` is null we generate a fresh identity; when
    // non-null we adopt the provided keypair. All other keys (signed
    // pre-key, pre-keys, kyber pre-keys, registrationId) are always
    // generated fresh — per-device material, never shared across linked
    // devices of the same user.
    private fun performIdentitySetup(
        deviceId: Int,
        name: String,
        importedIdentity: IdentityKeyPair?
    ): Map<String, Any> {
        val keystoreHelper = KeystoreHelper.getInstance(context)

        val keys = KeyGeneration.generateKeys(existingIdentity = importedIdentity)
        val identityKeyPairData = keys.identityKeyPair.serialize()

        val preKeysArray = org.json.JSONArray()
        keys.preKeys.forEach { preKeyRecord ->
            val obj = org.json.JSONObject()
            obj.put("id", preKeyRecord.id)
            obj.put("publicKey", Base64.encodeToString(preKeyRecord.keyPair.publicKey.serialize(), Base64.NO_WRAP))
            obj.put("key", Base64.encodeToString(preKeyRecord.serialize(), Base64.NO_WRAP))
            preKeysArray.put(obj)
        }

        val kyberPreKeysArray = org.json.JSONArray()
        keys.kyberPreKeys.forEach { kyberPreKey ->
            val obj = org.json.JSONObject()
            obj.put("id", kyberPreKey.id)
            obj.put("publicKey", Base64.encodeToString(kyberPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP))
            obj.put("signature", Base64.encodeToString(kyberPreKey.signature, Base64.NO_WRAP))
            obj.put("key", Base64.encodeToString(kyberPreKey.serialize(), Base64.NO_WRAP))
            kyberPreKeysArray.put(obj)
        }

        if (!keystoreHelper.saveProtected(identityKeyPairStorageKey, identityKeyPairData)) {
            throw Exception("Failed to save identity key pair")
        }

        val metadata = org.json.JSONObject()
        metadata.put("registrationId", keys.registrationId)
        metadata.put("deviceId", deviceId)
        metadata.put("name", name)
        metadata.put("signedPreKeyRecord", Base64.encodeToString(keys.signedPreKeyRecord.serialize(), Base64.NO_WRAP))
        metadata.put("preKeys", preKeysArray)
        metadata.put("kyberPreKeys", kyberPreKeysArray)

        if (!keystoreHelper.save(localUserMetadataStorageKey, metadata.toString().toByteArray(Charsets.UTF_8))) {
            keystoreHelper.deleteProtected(identityKeyPairStorageKey)
            throw Exception("Failed to save metadata")
        }

        val newLocalUser = LocalUser(
            identityKey = keys.identityKeyPair,
            registrationId = keys.registrationId.toUInt(),
            preKeys = keys.preKeys,
            signedPreKey = keys.signedPreKeyRecord,
            kyberPreKeys = keys.kyberPreKeys,
            deviceId = deviceId.toUInt(),
            name = name
        )
        localUser = newLocalUser

        newLocalUser.preKeys.forEach { preKey ->
            sharedPreKeyStore?.storePreKey(preKey.id, preKey)
        }
        sharedSignedPreKeyStore?.storeSignedPreKey(newLocalUser.signedPreKey.id, newLocalUser.signedPreKey)
        newLocalUser.kyberPreKeys.forEach { kyberPreKey ->
            sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey.id, kyberPreKey)
        }

        val publicPreKeys = keys.preKeys.map { preKeyRecord ->
            mapOf(
                "id" to preKeyRecord.id,
                "publicKey" to Base64.encodeToString(preKeyRecord.keyPair.publicKey.serialize(), Base64.NO_WRAP)
            )
        }

        val publicKyberPreKeys = keys.kyberPreKeys.map { kyberPreKey ->
            mapOf(
                "id" to kyberPreKey.id,
                "publicKey" to Base64.encodeToString(kyberPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                "signature" to Base64.encodeToString(kyberPreKey.signature, Base64.NO_WRAP)
            )
        }

        return mapOf(
            "registrationId" to keys.registrationId,
            "deviceId" to deviceId,
            "identityPublicKey" to keys.identityKeyPublicBase64(),
            "signedPreKey" to mapOf(
                "id" to keys.signedPreKeyId().toInt(),
                "publicKey" to keys.signedPreKeyPublicKeyBase64(),
                "signature" to keys.signedPreKeyRecordSignatureBase64()
            ),
            "preKeys" to publicPreKeys,
            "kyberPreKeys" to publicKyberPreKeys
        )
    }

    // Shared ECDHE + HKDF + AES-256-GCM encrypt for the multi-device
    // provisioning envelope. Returns the binary blob
    // `[1B v=0x01][12B IV][N B ct][16B tag]`. Used by both the low-level
    // `encryptProvisioning` AsyncFunction and the high-level
    // `encryptProvisioningPayload` AsyncFunction.
    // Normalize an X25519 public key to libsignal's DJB framed form
    // (33 bytes, prefixed with 0x05). Non-libsignal clients (Web Crypto,
    // libsodium, @stablelib — e.g. the desktop) emit the raw 32 bytes.
    // Wrap them so `ECPublicKey(...)` doesn't throw `invalidKey` (error 11).
    private fun normalizeDjbPublicKey(data: ByteArray): ByteArray {
        if (data.size == 32) {
            val out = ByteArray(33)
            out[0] = 0x05
            System.arraycopy(data, 0, out, 1, 32)
            return out
        }
        return data
    }

    private fun encryptProvisioningEnvelope(
        plaintext: ByteArray,
        recipientPublicKey: String,
        senderPrivateKey: String
    ): ByteArray {
        val recipientPubBytes = Base64.decode(recipientPublicKey, Base64.NO_WRAP)
        val senderPrivBytes = Base64.decode(senderPrivateKey, Base64.NO_WRAP)
        val recipientPub = ECPublicKey(normalizeDjbPublicKey(recipientPubBytes))
        val senderPriv = ECPrivateKey(senderPrivBytes)
        val sharedSecret = senderPriv.calculateAgreement(recipientPub)

        val info = "tillit/provisioning/v1".toByteArray(Charsets.UTF_8)
        val derivedKey = HKDF.deriveSecrets(sharedSecret, ByteArray(0), info, 32)

        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(derivedKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(info)
        val ciphertextWithTag = cipher.doFinal(plaintext)

        return ByteBuffer.allocate(1 + nonce.size + ciphertextWithTag.size)
            .put(0x01.toByte())
            .put(nonce)
            .put(ciphertextWithTag)
            .array()
    }

    private fun decryptProvisioningEnvelope(
        ciphertextBase64: String,
        recipientPrivateKey: String,
        senderPublicKey: String
    ): ByteArray {
        val envelope = Base64.decode(ciphertextBase64, Base64.NO_WRAP)
        if (envelope.size <= 1 + 12 + 16) {
            throw Exception("Provisioning ciphertext too short")
        }
        if (envelope[0].toInt() != 0x01) {
            throw Exception("Unsupported provisioning ciphertext version")
        }
        val nonce = envelope.copyOfRange(1, 13)
        val ciphertextWithTag = envelope.copyOfRange(13, envelope.size)

        val recipientPrivBytes = Base64.decode(recipientPrivateKey, Base64.NO_WRAP)
        val senderPubBytes = Base64.decode(senderPublicKey, Base64.NO_WRAP)
        val recipientPriv = ECPrivateKey(recipientPrivBytes)
        val senderPub = ECPublicKey(normalizeDjbPublicKey(senderPubBytes))
        val sharedSecret = recipientPriv.calculateAgreement(senderPub)

        val info = "tillit/provisioning/v1".toByteArray(Charsets.UTF_8)
        val derivedKey = HKDF.deriveSecrets(sharedSecret, ByteArray(0), info, 32)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(derivedKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(info)
        return cipher.doFinal(ciphertextWithTag)
    }

    override fun definition() = ModuleDefinition {
        Name("SignalProtocol")

        OnCreate {
            val ctx = appContext.reactContext ?: return@OnCreate
            senderKeyStore = PersistentSenderKeyStore("TilliTSenderKeys", ctx)
            val sharedStorePrefix = "TilliTLocalKeys"
            sharedPreKeyStore = PersistentPreKeyStore(sharedStorePrefix, ctx)
            sharedSignedPreKeyStore = PersistentSignedPreKeyStore(sharedStorePrefix, ctx)
            sharedKyberPreKeyStore = PersistentKyberPreKeyStore(sharedStorePrefix, ctx)
        }

        // ========== IDENTITY INITIALIZATION ==========

        AsyncFunction("initializeIdentity") { deviceId: Int, name: String, existingIdentityKey: Map<String, String>? ->
            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before creating identity")
            }

            // Multi-device pairing: when the caller passes a pre-existing
            // identity (linked device import via provisioning ciphertext),
            // import it instead of generating a fresh one. Wire format is
            // the combined libsignal IdentityKeyPair serialized blob (one
            // base64), byte-for-byte identical with the iOS side.
            //
            // NOTE: the production multi-device path uses
            // `consumeProvisioningPayload` instead, which keeps the imported
            // identity confined to native code. This `existingIdentityKey`
            // back door is retained for tests and edge-case tooling.
            val importedIdentity: IdentityKeyPair? = existingIdentityKey?.let { existing ->
                val serializedB64 = existing["serialized"]
                    ?: throw Exception("existingIdentityKey must include base64 `serialized`")
                val serializedBytes = Base64.decode(serializedB64, Base64.NO_WRAP)
                IdentityKeyPair(serializedBytes)
            }

            return@AsyncFunction performIdentitySetup(deviceId, name, importedIdentity)
        }

        AsyncFunction("getPublicIdentity") {
            val user = localUser ?: throw Exception("Local user not loaded. Call loadStoredLocalUser first.")

            val publicKeyData = user.identityKey.publicKey.serialize()
            val identityPublicKey = Base64.encodeToString(publicKeyData, Base64.NO_WRAP)

            return@AsyncFunction mapOf(
                "identityPublicKey" to identityPublicKey,
                "registrationId" to user.registrationId.toInt(),
                "deviceId" to user.deviceId.toInt()
            )
        }

        AsyncFunction("getSignedPreKeyInfo") {
            val user = localUser ?: throw Exception("Local user not loaded. Call loadStoredLocalUser first.")

            val signedPreKey = user.signedPreKey
            val publicKeyData = signedPreKey.keyPair.publicKey.serialize()

            return@AsyncFunction mapOf(
                "id" to signedPreKey.id,
                "publicKey" to Base64.encodeToString(publicKeyData, Base64.NO_WRAP),
                "signature" to Base64.encodeToString(signedPreKey.signature, Base64.NO_WRAP)
            )
        }

        AsyncFunction("getFullPublicBundle") {
            val user = localUser ?: throw Exception("Local user not loaded. Call loadStoredLocalUser first.")

            val identityPublicKey = Base64.encodeToString(
                user.identityKey.publicKey.serialize(),
                Base64.NO_WRAP
            )

            val signedPreKey = user.signedPreKey

            val preKeys = user.preKeys.map { preKey ->
                mapOf(
                    "id" to preKey.id,
                    "publicKey" to Base64.encodeToString(preKey.keyPair.publicKey.serialize(), Base64.NO_WRAP)
                )
            }

            val kyberPreKeys = user.kyberPreKeys.map { kyberPreKey ->
                mapOf(
                    "id" to kyberPreKey.id,
                    "publicKey" to Base64.encodeToString(kyberPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                    "signature" to Base64.encodeToString(kyberPreKey.signature, Base64.NO_WRAP)
                )
            }

            return@AsyncFunction mapOf(
                "registrationId" to user.registrationId.toInt(),
                "deviceId" to user.deviceId.toInt(),
                "identityPublicKey" to identityPublicKey,
                "signedPreKey" to mapOf(
                    "id" to signedPreKey.id,
                    "publicKey" to Base64.encodeToString(signedPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                    "signature" to Base64.encodeToString(signedPreKey.signature, Base64.NO_WRAP)
                ),
                "preKeys" to preKeys,
                "kyberPreKeys" to kyberPreKeys
            )
        }

        AsyncFunction("clearIdentity") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            keystoreHelper.clearAll()
            localUser = null
            encryptedSessions.clear()

            // H-01 FIX: Re-initialize all shared stores to prevent stale pre-keys
            // from a previous identity being used after re-login in the same app session
            senderKeyStore = PersistentSenderKeyStore("TilliTSenderKeys", context)
            val sharedStorePrefix = "TilliTLocalKeys"
            sharedPreKeyStore = PersistentPreKeyStore(sharedStorePrefix, context)
            sharedSignedPreKeyStore = PersistentSignedPreKeyStore(sharedStorePrefix, context)
            sharedKyberPreKeyStore = PersistentKyberPreKeyStore(sharedStorePrefix, context)
        }

        AsyncFunction("setLocalUserId") { userId: String ->
            val existingUser = localUser ?: throw Exception("Local user not loaded. Call loadStoredLocalUser first.")

            val updatedUser = LocalUser(
                identityKey = existingUser.identityKey,
                registrationId = existingUser.registrationId,
                preKeys = existingUser.preKeys,
                signedPreKey = existingUser.signedPreKey,
                kyberPreKeys = existingUser.kyberPreKeys,
                deviceId = existingUser.deviceId,
                name = userId
            )
            localUser = updatedUser

            // Update metadata in storage
            val keystoreHelper = KeystoreHelper.getInstance(context)
            val metadataBytes = keystoreHelper.load(localUserMetadataStorageKey)
            if (metadataBytes != null) {
                val metadata = org.json.JSONObject(String(metadataBytes, Charsets.UTF_8))
                metadata.put("name", userId)
                keystoreHelper.save(localUserMetadataStorageKey, metadata.toString().toByteArray(Charsets.UTF_8))
            }

            return@AsyncFunction mapOf("success" to true)
        }

        // ========== KEY ROTATION ==========

        AsyncFunction("replenishPreKeys") { startId: Int, count: Int ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")

            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before generating keys")
            }

            // 1. Generate new pre-keys
            val newPreKeys = KeyGeneration.generatePreKeys(startId, count)

            // 2. Load existing metadata
            val metadataBytes = keystoreHelper.load(localUserMetadataStorageKey)
                ?: throw Exception("Failed to load metadata")
            val metadata = org.json.JSONObject(String(metadataBytes, Charsets.UTF_8))
            val existingPreKeys = metadata.getJSONArray("preKeys")

            // 3. Append new pre-keys to storage format
            newPreKeys.forEach { preKeyRecord ->
                val obj = org.json.JSONObject()
                obj.put("id", preKeyRecord.id)
                obj.put("publicKey", Base64.encodeToString(preKeyRecord.keyPair.publicKey.serialize(), Base64.NO_WRAP))
                obj.put("key", Base64.encodeToString(preKeyRecord.serialize(), Base64.NO_WRAP))
                existingPreKeys.put(obj)
            }

            // M-05 FIX: Prevent unbounded metadata growth — keep only most recent 200
            val maxStoredPreKeys = 200
            if (existingPreKeys.length() > maxStoredPreKeys) {
                val trimmed = org.json.JSONArray()
                for (i in (existingPreKeys.length() - maxStoredPreKeys) until existingPreKeys.length()) {
                    trimmed.put(existingPreKeys.get(i))
                }
                metadata.put("preKeys", trimmed)
            } else {
                metadata.put("preKeys", existingPreKeys)
            }

            // 4. Save updated metadata
            if (!keystoreHelper.save(localUserMetadataStorageKey, metadata.toString().toByteArray(Charsets.UTF_8))) {
                throw Exception("Failed to save updated metadata")
            }

            // H6 FIX: Add to shared store
            newPreKeys.forEach { preKeyRecord ->
                sharedPreKeyStore?.storePreKey(preKeyRecord.id, preKeyRecord)
            }

            // 5. Return ONLY public keys
            val publicPreKeys = newPreKeys.map { preKeyRecord ->
                mapOf(
                    "id" to preKeyRecord.id,
                    "publicKey" to Base64.encodeToString(preKeyRecord.keyPair.publicKey.serialize(), Base64.NO_WRAP)
                )
            }

            return@AsyncFunction mapOf("preKeys" to publicPreKeys)
        }

        AsyncFunction("replenishKyberPreKeys") { startId: Int, count: Int ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")

            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before generating keys")
            }

            // 1. Generate new Kyber pre-keys
            val newKyberPreKeys = KeyGeneration.generateKyberPreKeys(startId, count, user.identityKey)

            // 2. Load existing metadata
            val metadataBytes = keystoreHelper.load(localUserMetadataStorageKey)
                ?: throw Exception("Failed to load metadata")
            val metadata = org.json.JSONObject(String(metadataBytes, Charsets.UTF_8))
            val existingKyberPreKeys = metadata.getJSONArray("kyberPreKeys")

            // 3. Append new Kyber pre-keys to storage format
            newKyberPreKeys.forEach { kyberPreKey ->
                val obj = org.json.JSONObject()
                obj.put("id", kyberPreKey.id)
                obj.put("publicKey", Base64.encodeToString(kyberPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP))
                obj.put("signature", Base64.encodeToString(kyberPreKey.signature, Base64.NO_WRAP))
                obj.put("key", Base64.encodeToString(kyberPreKey.serialize(), Base64.NO_WRAP))
                existingKyberPreKeys.put(obj)
            }

            // M-05 FIX: Prevent unbounded metadata growth — keep only most recent 200
            val maxStoredKyberPreKeys = 200
            if (existingKyberPreKeys.length() > maxStoredKyberPreKeys) {
                val trimmed = org.json.JSONArray()
                for (i in (existingKyberPreKeys.length() - maxStoredKyberPreKeys) until existingKyberPreKeys.length()) {
                    trimmed.put(existingKyberPreKeys.get(i))
                }
                metadata.put("kyberPreKeys", trimmed)
            } else {
                metadata.put("kyberPreKeys", existingKyberPreKeys)
            }

            // 4. Save updated metadata
            if (!keystoreHelper.save(localUserMetadataStorageKey, metadata.toString().toByteArray(Charsets.UTF_8))) {
                throw Exception("Failed to save updated metadata")
            }

            // H6 FIX: Add to shared store
            newKyberPreKeys.forEach { kyberPreKey ->
                sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey.id, kyberPreKey)
            }

            // 5. Return ONLY public keys
            val publicKyberPreKeys = newKyberPreKeys.map { kyberPreKey ->
                mapOf(
                    "id" to kyberPreKey.id,
                    "publicKey" to Base64.encodeToString(kyberPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                    "signature" to Base64.encodeToString(kyberPreKey.signature, Base64.NO_WRAP)
                )
            }

            return@AsyncFunction mapOf("kyberPreKeys" to publicKyberPreKeys)
        }

        AsyncFunction("rotateSignedPreKey") {
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")

            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before rotating keys")
            }

            // 1. Generate new signed pre-key
            val signedPreKeyId = SecureRandom().nextInt(KeyGeneration.MAX_VAL - 2) + 1
            val newSignedPreKey = KeyGeneration.generateSignedPreKey(user.identityKey, signedPreKeyId)

            // 2. Load existing metadata
            val metadataBytes = keystoreHelper.load(localUserMetadataStorageKey)
                ?: throw Exception("Failed to load metadata")
            val metadata = org.json.JSONObject(String(metadataBytes, Charsets.UTF_8))

            // 3. Update signed pre-key in metadata
            metadata.put("signedPreKeyRecord", Base64.encodeToString(newSignedPreKey.serialize(), Base64.NO_WRAP))

            // 4. Save updated metadata
            if (!keystoreHelper.save(localUserMetadataStorageKey, metadata.toString().toByteArray(Charsets.UTF_8))) {
                throw Exception("Failed to save updated metadata")
            }

            // 5. Update localUser with new signed pre-key
            localUser = LocalUser(
                identityKey = user.identityKey,
                registrationId = user.registrationId,
                preKeys = user.preKeys,
                signedPreKey = newSignedPreKey,
                kyberPreKeys = user.kyberPreKeys,
                deviceId = user.deviceId,
                name = user.name
            )

            // H7 FIX: Update shared store
            sharedSignedPreKeyStore?.storeSignedPreKey(newSignedPreKey.id, newSignedPreKey)

            // 6. Return ONLY public key info
            return@AsyncFunction mapOf(
                "id" to newSignedPreKey.id,
                "publicKey" to Base64.encodeToString(newSignedPreKey.keyPair.publicKey.serialize(), Base64.NO_WRAP),
                "signature" to Base64.encodeToString(newSignedPreKey.signature, Base64.NO_WRAP)
            )
        }

        // ========== SESSION MANAGEMENT ==========

        AsyncFunction("setRemoteUserKeys") { params: Map<String, Any?> ->
            val user = localUser ?: throw Exception("Local user is not set. Call loadStoredLocalUser first.")

            val remoteUserId = params["remoteUserId"] as? String ?: throw Exception("Missing remoteUserId")
            val preKeyId = (params["preKeyId"] as? Number)?.toInt() ?: throw Exception("Missing preKeyId")
            val preKeyPublicKeyBase64 = params["preKeyPublicKey"] as? String ?: throw Exception("Missing preKeyPublicKey")
            val signedPreKeyId = (params["signedPreKeyId"] as? Number)?.toInt() ?: throw Exception("Missing signedPreKeyId")
            val signedPreKeyPublicKeyBase64 = params["signedPreKeyPublicKey"] as? String ?: throw Exception("Missing signedPreKeyPublicKey")
            val signedPreKeySignatureBase64 = params["signedPreKeySignature"] as? String ?: throw Exception("Missing signedPreKeySignature")
            val identityPublicKeyBase64 = params["identityPublicKey"] as? String ?: throw Exception("Missing identityPublicKey")
            val registrationId = (params["registrationId"] as? Number)?.toInt() ?: throw Exception("Missing registrationId")
            val deviceId = (params["deviceId"] as? Number)?.toInt() ?: throw Exception("Missing deviceId")
            val kyberPreKeyId = (params["kyberPreKeyId"] as? Number)?.toInt() ?: throw Exception("Missing kyberPreKeyId")
            val kyberPreKeyPublicKeyBase64 = params["kyberPreKeyPublicKey"] as? String ?: throw Exception("Missing kyberPreKeyPublicKey")
            val kyberPreKeySignatureBase64 = params["kyberPreKeySignature"] as? String ?: throw Exception("Missing kyberPreKeySignature")

            val preKeyPublicKeyData = Base64.decode(preKeyPublicKeyBase64, Base64.NO_WRAP)
            val signedPreKeyPublicKeyData = Base64.decode(signedPreKeyPublicKeyBase64, Base64.NO_WRAP)
            val signedPreKeySignatureData = Base64.decode(signedPreKeySignatureBase64, Base64.NO_WRAP)
            val identityPublicKeyData = Base64.decode(identityPublicKeyBase64, Base64.NO_WRAP)
            val kyberPreKeyPublicKeyData = Base64.decode(kyberPreKeyPublicKeyBase64, Base64.NO_WRAP)
            val kyberPreKeySignatureData = Base64.decode(kyberPreKeySignatureBase64, Base64.NO_WRAP)

            // CRITICAL: Use remoteUserId (not display name) as ProtocolAddress.name
            val remoteUser = RemoteUser(
                preKeyId = preKeyId,
                preKeyPublicKey = preKeyPublicKeyData,
                signedPreKeyId = signedPreKeyId,
                signedPreKeyPublicKey = signedPreKeyPublicKeyData,
                signedPreKeySignature = signedPreKeySignatureData,
                identityKeyPairPublicKey = identityPublicKeyData,
                deviceId = deviceId,
                name = remoteUserId,
                registrationId = registrationId,
                kyberPreKeyId = kyberPreKeyId,
                kyberPreKeyPublicKey = kyberPreKeyPublicKeyData,
                kyberPreKeySignature = kyberPreKeySignatureData
            )

            val session = EncryptedSession(
                user,
                remoteUser.protocolAddress,
                remoteUser,
                remoteUserId,
                sharedPreKeyStore!!,
                sharedSignedPreKeyStore!!,
                sharedKyberPreKeyStore!!,
                context
            )
            putEncryptedSession(remoteUserId, deviceId, session)
        }

        AsyncFunction("establishSession") { remoteUserId: String ->
            // NOTE (multi-device): establishSession is invoked by JS after
            // setRemoteUserKeys, which is keyed by (userId, deviceId). This
            // status check falls back to the default deviceId=1 slot;
            // multi-device callers can confirm via decryptMessage anyway.
            if (getEncryptedSession(remoteUserId) == null) {
                throw Exception("Session is not initialized. Set local and remote user keys first.")
            }

            return@AsyncFunction mapOf("status" to "Session established successfully")
        }

        AsyncFunction("resumeSession") { remoteUserId: String, remoteUserName: String, remoteUserDeviceId: Int ->
            val user = localUser ?: throw Exception("Local user not set. Ensure loadStoredLocalUser was called.")

            // Memoization (frontend-0016): if a warm EncryptedSession already
            // exists for this (userId, deviceId), reuse it instead of rebuilding.
            // Reconstructing re-creates the per-session store wrappers and
            // re-opens the encrypted stores on every encrypt; the warm instance
            // already carries the Double Ratchet state, so overwriting it is
            // pure overhead. Explicit rebuilds (recovery after a decrypt error,
            // key rotation) go through setRemoteUserKeys, which always creates a
            // fresh session — resumeSession is not the path for that.
            if (getEncryptedSession(remoteUserId, remoteUserDeviceId) != null) {
                return@AsyncFunction mapOf("status" to "Session already warm")
            }

            // CRITICAL: Use remoteUserId as name for consistent identity key lookup
            val address = SignalProtocolAddress(remoteUserId, remoteUserDeviceId)
            val session = EncryptedSession(
                user,
                address,
                null,  // No remoteUser for resumed sessions
                remoteUserId,
                sharedPreKeyStore!!,
                sharedSignedPreKeyStore!!,
                sharedKyberPreKeyStore!!,
                context
            )
            putEncryptedSession(remoteUserId, remoteUserDeviceId, session)

            return@AsyncFunction mapOf("status" to "Session resumed successfully")
        }

        // ========== ENCRYPTION/DECRYPTION ==========

        AsyncFunction("encryptMessage") { message: String, remoteUserId: String, remoteDeviceId: Int? ->
            // Multi-device (ADR-0001 D4): look up the session by
            // (userId, deviceId). Default deviceId=1 keeps single-device
            // peers and not-yet-updated call sites working unchanged.
            val effectiveDeviceId = remoteDeviceId ?: 1
            val session = getEncryptedSession(remoteUserId, effectiveDeviceId)
                ?: throw Exception("Session for remoteUserId $remoteUserId (device $effectiveDeviceId) is not initialized.")

            val encryptedMessage = session.encrypt(message)
            return@AsyncFunction mapOf("encryptedMessage" to encryptedMessage)
        }

        AsyncFunction("decryptMessage") { encryptedMessage: String, remoteUserId: String, deviceId: Int? ->
            // Multi-device (ADR-0001 D4): use the sender's deviceId from the
            // message envelope to find / create the (userId, deviceId) slot.
            // Default 1 for backward-compat.
            val effectiveDeviceId = deviceId ?: 1
            val session: EncryptedSession
            val existing = getEncryptedSession(remoteUserId, effectiveDeviceId)
            if (existing != null) {
                session = existing
            } else {
                // Auto-establish: create session without remote keys to handle
                // PreKeySignalMessage (X3DH). libsignal will use our shared
                // pre-key stores to decrypt and establish the session automatically.
                val user = localUser
                    ?: throw Exception("Local user not set. Ensure loadStoredLocalUser was called.")
                val address = SignalProtocolAddress(remoteUserId, effectiveDeviceId)
                session = EncryptedSession(
                    user, address, null, remoteUserId,
                    sharedPreKeyStore!!, sharedSignedPreKeyStore!!, sharedKyberPreKeyStore!!,
                    context
                )
            }

            val decryptedMessage = session.decrypt(encryptedMessage)
                ?: throw Exception("Decrypted message is nil")

            // Decrypt succeeded — persist session (auto-established via PreKeySignalMessage)
            putEncryptedSession(remoteUserId, effectiveDeviceId, session)

            return@AsyncFunction mapOf("message" to decryptedMessage)
        }

        // ========== MULTI-DEVICE PROVISIONING ==========
        //
        // X25519 ECDHE + HKDF-SHA256 + AES-256-GCM helpers used by the
        // multi-device pairing flow. See _shared/api/multi-device-linking.md
        // for the wire contract and _shared/decisions/0001-multi-device-architecture.md
        // (ADR-0001 §D2) for the rationale.

        AsyncFunction("generateProvisioningKeypair") {
            val privateKey = ECPrivateKey.generate()
            val publicKey = privateKey.getPublicKey()
            return@AsyncFunction mapOf(
                "publicKey" to Base64.encodeToString(publicKey.serialize(), Base64.NO_WRAP),
                "privateKey" to Base64.encodeToString(privateKey.serialize(), Base64.NO_WRAP)
            )
        }

        AsyncFunction("encryptProvisioning") {
            plaintextBase64: String, recipientPublicKey: String, senderPrivateKey: String ->
            val plaintext = Base64.decode(plaintextBase64, Base64.NO_WRAP)
            val envelope = encryptProvisioningEnvelope(plaintext, recipientPublicKey, senderPrivateKey)
            return@AsyncFunction mapOf(
                "ciphertext" to Base64.encodeToString(envelope, Base64.NO_WRAP)
            )
        }

        AsyncFunction("decryptProvisioning") {
            ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String ->
            val plaintext = decryptProvisioningEnvelope(ciphertextBase64, recipientPrivateKey, senderPublicKey)
            return@AsyncFunction mapOf(
                "plaintext" to Base64.encodeToString(plaintext, Base64.NO_WRAP)
            )
        }

        // High-level pairing wrappers — see ADR-0001 (Option B).
        // The identity private key NEVER crosses the JS boundary.

        AsyncFunction("encryptProvisioningPayload") {
            recipientPublicKey: String, senderPrivateKey: String, primaryUserId: String, primaryName: String? ->
            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before reading identity for pairing")
            }
            // Load the primary's identity from protected storage. Stays inside
            // this function — consumed inline to build the payload and
            // discarded (Kotlin GC) when the AsyncFunction returns.
            val identityKeyPairData = keystoreHelper.loadProtected(identityKeyPairStorageKey)
                ?: throw Exception("No identity stored — cannot produce a provisioning payload")
            val identityKeyPair = IdentityKeyPair(identityKeyPairData)
            val identityKeySerialized = Base64.encodeToString(identityKeyPair.serialize(), Base64.NO_WRAP)
            val identityKeyPub = Base64.encodeToString(identityKeyPair.publicKey.serialize(), Base64.NO_WRAP)

            val payload = org.json.JSONObject()
            payload.put("v", 1)
            payload.put("identityKeySerialized", identityKeySerialized)
            payload.put("identityKeyPub", identityKeyPub)
            payload.put("primaryUserId", primaryUserId)
            if (primaryName != null) {
                payload.put("primaryName", primaryName)
            }
            val plaintextBytes = payload.toString().toByteArray(Charsets.UTF_8)

            val envelope = encryptProvisioningEnvelope(plaintextBytes, recipientPublicKey, senderPrivateKey)
            return@AsyncFunction mapOf(
                "ciphertext" to Base64.encodeToString(envelope, Base64.NO_WRAP)
            )
        }

        AsyncFunction("peekProvisioningPayload") {
            ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String ->
            // Decrypt and integrity-check the provisioning payload WITHOUT
            // installing the identity. Used by the new device to compute the
            // pairing safety number and show it to the user before committing
            // anything to persistent state.
            val plaintextBytes = decryptProvisioningEnvelope(ciphertextBase64, recipientPrivateKey, senderPublicKey)
            val plaintextString = String(plaintextBytes, Charsets.UTF_8)
            val parsed = try {
                org.json.JSONObject(plaintextString)
            } catch (e: Exception) {
                throw Exception("Provisioning payload is not valid JSON")
            }

            val version = parsed.optInt("v", -1)
            if (version != 1) {
                throw Exception("Unsupported provisioning payload version")
            }
            val serializedB64 = parsed.optString("identityKeySerialized", "")
            val identityPubB64 = parsed.optString("identityKeyPub", "")
            val primaryUserId = parsed.optString("primaryUserId", "")
            if (serializedB64.isEmpty() || identityPubB64.isEmpty() || primaryUserId.isEmpty()) {
                throw Exception("Provisioning payload missing required fields")
            }

            // Integrity check: identityKeyPub must equal the public half of
            // the deserialized keypair. Catches a tampered payload here, BEFORE
            // we hand the resulting safety number to the user.
            val serializedBytes = Base64.decode(serializedB64, Base64.NO_WRAP)
            val importedIdentity = IdentityKeyPair(serializedBytes)
            val recoveredPub = Base64.encodeToString(importedIdentity.publicKey.serialize(), Base64.NO_WRAP)
            if (recoveredPub != identityPubB64) {
                throw Exception("Provisioning payload integrity check failed: identityKeyPub does not match identityKeySerialized")
            }

            // `importedIdentity` and `serializedBytes` go out of scope here —
            // the JVM GC will reclaim them. The private key is never persisted
            // or returned to the JS layer.
            val result = mutableMapOf<String, Any>(
                "primaryUserId" to primaryUserId,
                "identityKeyPub" to identityPubB64
            )
            val primaryName = parsed.optString("primaryName", "")
            if (primaryName.isNotEmpty()) {
                result["primaryName"] = primaryName
            }
            return@AsyncFunction result
        }

        AsyncFunction("consumeProvisioningPayload") {
            ciphertextBase64: String, recipientPrivateKey: String, senderPublicKey: String, deviceId: Int, name: String ->
            val keystoreHelper = KeystoreHelper.getInstance(context)
            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must authenticate before installing a provisioned identity")
            }

            val plaintextBytes = decryptProvisioningEnvelope(ciphertextBase64, recipientPrivateKey, senderPublicKey)
            val plaintextString = String(plaintextBytes, Charsets.UTF_8)
            val parsed = try {
                org.json.JSONObject(plaintextString)
            } catch (e: Exception) {
                throw Exception("Provisioning payload is not valid JSON")
            }

            val version = parsed.optInt("v", -1)
            if (version != 1) {
                throw Exception("Unsupported provisioning payload version")
            }
            val serializedB64 = parsed.optString("identityKeySerialized", "")
            val identityPubB64 = parsed.optString("identityKeyPub", "")
            if (serializedB64.isEmpty() || identityPubB64.isEmpty()) {
                throw Exception("Provisioning payload missing required fields")
            }
            val serializedBytes = Base64.decode(serializedB64, Base64.NO_WRAP)
            val importedIdentity = IdentityKeyPair(serializedBytes)

            // Cross-check: the embedded identityKeyPub MUST match the public
            // key we recover from the serialized keypair. Detects a malformed
            // or tampered payload before it reaches the Keystore.
            val recoveredPub = Base64.encodeToString(importedIdentity.publicKey.serialize(), Base64.NO_WRAP)
            if (recoveredPub != identityPubB64) {
                throw Exception("Provisioning payload integrity check failed: identityKeyPub does not match identityKeySerialized")
            }

            return@AsyncFunction performIdentitySetup(deviceId, name, importedIdentity)
        }

        AsyncFunction("getPairingSafetyNumber") {
            ephemeralPubA: String, ephemeralPubB: String, identityPub: String, primaryUserId: String ->

            val aBytes = Base64.decode(ephemeralPubA, Base64.NO_WRAP)
            val bBytes = Base64.decode(ephemeralPubB, Base64.NO_WRAP)
            val idBytes = Base64.decode(identityPub, Base64.NO_WRAP)

            // Transcript hash: SHA-256(A || B || identityPub)
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(aBytes)
            digest.update(bBytes)
            digest.update(idBytes)
            val transcript = digest.digest()

            // HKDF: salt = "tillit/pairing/sn/v1", info = primaryUserId, L = 30
            val salt = "tillit/pairing/sn/v1".toByteArray(Charsets.UTF_8)
            val info = primaryUserId.toByteArray(Charsets.UTF_8)
            val snBytes = HKDF.deriveSecrets(transcript, salt, info, 30)

            // 30 B → 6 blocks of 5 B → uint40 → mod 10^10 → 10 zero-padded digits → 60 total
            val digits = StringBuilder(60)
            for (blockIdx in 0 until 6) {
                var v = 0L
                for (byteIdx in 0 until 5) {
                    v = (v shl 8) or (snBytes[blockIdx * 5 + byteIdx].toLong() and 0xFF)
                }
                v %= 10_000_000_000L
                digits.append(String.format(Locale.US, "%010d", v))
            }
            // Format as 12 groups of 5 digits separated by single spaces.
            val groups = StringBuilder()
            for (i in 0 until 12) {
                if (i > 0) groups.append(' ')
                groups.append(digits.substring(i * 5, i * 5 + 5))
            }
            return@AsyncFunction mapOf("safetyNumber" to groups.toString())
        }

        // ========== REMOTE SESSION MANAGEMENT (multi-device revocation) ==========

        AsyncFunction("deleteRemoteSession") { remoteUserId: String, remoteDeviceId: Int? ->
            // Multi-device (ADR-0001 D6): drop only the session for the
            // revoked (userId, deviceId). Other devices of the same peer
            // keep encrypting/decrypting normally.
            removeEncryptedSession(remoteUserId, remoteDeviceId ?: 1)
        }

        // ========== IDENTITY VERIFICATION ==========

        AsyncFunction("getSafetyNumber") { remoteUserId: String ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")
            val session = getEncryptedSession(remoteUserId)
                ?: throw Exception("Session for remoteUserId $remoteUserId is not initialized.")

            val remoteIdentity = session.identityStore.getIdentity(session.remoteAddress)
                ?: throw Exception("No identity found for remote user")

            val safetyNumber = session.identityStore.generateSafetyNumber(user.name, session.remoteAddress, remoteIdentity)
            return@AsyncFunction mapOf("safetyNumber" to safetyNumber)
        }

        AsyncFunction("verifyIdentity") { remoteUserId: String ->
            val session = getEncryptedSession(remoteUserId)
                ?: throw Exception("Session for remoteUserId $remoteUserId is not initialized.")

            val remoteIdentity = session.identityStore.getIdentity(session.remoteAddress)
                ?: throw Exception("No identity found for remote user")

            session.identityStore.setManuallyTrusted(session.remoteAddress, remoteIdentity)
            return@AsyncFunction mapOf("status" to "Identity verified and marked as trusted")
        }

        // H8 FIX: Full implementation with identity key comparison
        AsyncFunction("checkIdentityKeyChanged") { remoteUserId: String, identityKey: String? ->
            val session = getEncryptedSession(remoteUserId)
                ?: throw Exception("Session for remoteUserId $remoteUserId is not initialized.")

            val storedIdentity = session.identityStore.getIdentity(session.remoteAddress)
            if (storedIdentity == null) {
                return@AsyncFunction mapOf("changed" to false, "reason" to "No identity saved yet")
            }

            // H8 FIX: If identityKey is provided, compare with stored one
            if (identityKey != null) {
                val newIdentityKeyBytes = Base64.decode(identityKey, Base64.NO_WRAP)
                val newIdentityKey = IdentityKey(newIdentityKeyBytes)

                val hasChanged = storedIdentity != newIdentityKey

                val result = mutableMapOf<String, Any?>(
                    "changed" to hasChanged,
                    "identityExists" to true
                )

                if (hasChanged) {
                    result["previousKey"] = Base64.encodeToString(storedIdentity.serialize(), Base64.NO_WRAP)
                }

                return@AsyncFunction result.toMap()
            }

            // Legacy behavior: only check existence
            return@AsyncFunction mapOf("changed" to false, "identityExists" to true)
        }

        // ========== SENDER KEYS (GROUP ENCRYPTION) ==========

        AsyncFunction("createSenderKeySession") { roomId: String, distributionIdString: String ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")

            val distributionId = try {
                UUID.fromString(distributionIdString)
            } catch (e: IllegalArgumentException) {
                throw Exception("Invalid distributionId format - must be UUID")
            }

            val localAddress = SignalProtocolAddress(user.name, user.deviceId.toInt())

            val builder = GroupSessionBuilder(store)
            val distributionMessage = builder.create(localAddress, distributionId)

            val base64 = Base64.encodeToString(distributionMessage.serialize(), Base64.NO_WRAP)

            return@AsyncFunction mapOf("distributionMessage" to base64)
        }

        AsyncFunction("processSenderKeyDistribution") { roomId: String, senderId: String, distributionMessageBase64: String, senderDeviceId: Int? ->
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")

            val data = Base64.decode(distributionMessageBase64, Base64.NO_WRAP)
            val distributionMessage = SenderKeyDistributionMessage(data)

            val senderAddress = SignalProtocolAddress(senderId, senderDeviceId ?: 1)

            val builder = GroupSessionBuilder(store)
            builder.process(senderAddress, distributionMessage)
        }

        AsyncFunction("encryptGroupMessage") { message: String, roomId: String, distributionIdString: String ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")

            val distributionId = try {
                UUID.fromString(distributionIdString)
            } catch (e: IllegalArgumentException) {
                throw Exception("Invalid distributionId format - must be UUID")
            }

            val localAddress = SignalProtocolAddress(user.name, user.deviceId.toInt())

            val cipher = GroupCipher(store, localAddress)
            val ciphertext = cipher.encrypt(distributionId, message.toByteArray())

            val base64 = Base64.encodeToString(ciphertext.serialize(), Base64.NO_WRAP)

            return@AsyncFunction mapOf("ciphertext" to base64)
        }

        AsyncFunction("decryptGroupMessage") { ciphertextBase64: String, roomId: String, senderId: String, senderDeviceId: Int? ->
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")

            val senderAddress = SignalProtocolAddress(senderId, senderDeviceId ?: 1)
            val data = Base64.decode(ciphertextBase64, Base64.NO_WRAP)

            val cipher = GroupCipher(store, senderAddress)
            val plaintext = cipher.decrypt(data)

            val message = String(plaintext, Charsets.UTF_8)

            return@AsyncFunction mapOf("message" to message)
        }

        AsyncFunction("rotateSenderKey") { roomId: String ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")

            val localAddress = SignalProtocolAddress(user.name, user.deviceId.toInt())

            val newDistributionId = UUID.randomUUID()

            val builder = GroupSessionBuilder(store)
            val distributionMessage = builder.create(localAddress, newDistributionId)

            val base64 = Base64.encodeToString(distributionMessage.serialize(), Base64.NO_WRAP)

            return@AsyncFunction mapOf(
                "distributionMessage" to base64,
                "distributionId" to newDistributionId.toString()
            )
        }

        AsyncFunction("deleteSenderKeySession") { roomId: String ->
            val store = senderKeyStore ?: throw Exception("Sender key store not initialized")
            store.deleteAllSenderKeys(roomId)
        }

        // ========== AUTHENTICATION ==========

        AsyncFunction("signWithIdentityKey") { dataBase64: String ->
            val user = localUser ?: throw Exception("Local user not set. Call loadStoredLocalUser first.")

            val dataToSign = Base64.decode(dataBase64, Base64.NO_WRAP)
            val signature = user.identityKey.privateKey.calculateSignature(dataToSign)
            val signatureBase64 = Base64.encodeToString(signature, Base64.NO_WRAP)

            return@AsyncFunction mapOf("signature" to signatureBase64)
        }

        // ========== BIOMETRIC/PASSCODE AUTHENTICATION ==========

        // authenticate() needs Activity for BiometricPrompt — use Promise explicitly
        AsyncFunction("authenticate") { reason: String?, promise: Promise ->
            val reasonText = reason ?: "Sblocca le chiavi di cifratura"

            val activity = appContext.currentActivity as? FragmentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No FragmentActivity available", null)
                return@AsyncFunction
            }

            val keystoreHelper = KeystoreHelper.getInstance(context)
            activity.runOnUiThread {
                keystoreHelper.authenticate(activity, reasonText) { success, error ->
                    if (success) {
                        promise.resolve(mapOf("success" to true))
                    } else {
                        promise.resolve(mapOf("success" to false, "error" to error))
                    }
                }
            }
        }

        Function("isAuthenticated") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            return@Function mapOf("authenticated" to keystoreHelper.isAuthenticated)
        }

        Function("lock") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            keystoreHelper.lock()
        }

        Function("extendAuthentication") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            keystoreHelper.touchAuthentication()
            return@Function mapOf("success" to true)
        }

        // ========== HARDWARE-PROTECTED GENERIC STORAGE ==========
        // Surface KeystoreHelper.saveProtected/loadProtected to JS so consumers
        // (e.g. SQLCipher DB key) can store arbitrary secrets behind the same
        // hardware-bound AES-GCM key used by the Signal identity material.

        AsyncFunction("setProtectedData") { key: String, dataBase64: String ->
            if (!key.startsWith("tillit_protected/")) {
                throw Exception("Protected keys must use the tillit_protected/ prefix")
            }
            val data = Base64.decode(dataBase64, Base64.NO_WRAP)
            val keystoreHelper = KeystoreHelper.getInstance(context)
            val saved = keystoreHelper.saveProtected(key, data)
            if (!saved) {
                throw Exception("Not authenticated or keystore write failed")
            }
            return@AsyncFunction mapOf("success" to true)
        }

        AsyncFunction("getProtectedData") { key: String ->
            if (!key.startsWith("tillit_protected/")) {
                throw Exception("Protected keys must use the tillit_protected/ prefix")
            }
            val keystoreHelper = KeystoreHelper.getInstance(context)
            val data = keystoreHelper.loadProtected(key)
            return@AsyncFunction mapOf("data" to (data?.let { Base64.encodeToString(it, Base64.NO_WRAP) }))
        }

        AsyncFunction("deleteProtectedData") { key: String ->
            if (!key.startsWith("tillit_protected/")) {
                throw Exception("Protected keys must use the tillit_protected/ prefix")
            }
            val keystoreHelper = KeystoreHelper.getInstance(context)
            val deleted = keystoreHelper.deleteProtected(key)
            return@AsyncFunction mapOf("success" to deleted)
        }

        Function("checkDeviceSecurity") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            return@Function mapOf("isSecure" to keystoreHelper.isDeviceSecure())
        }

        Function("hasStoredIdentity") {
            val keystoreHelper = KeystoreHelper.getInstance(context)
            val hasIdentity = keystoreHelper.existsProtected(identityKeyPairStorageKey)
            val hasMetadata = keystoreHelper.exists(localUserMetadataStorageKey)
            return@Function mapOf("hasStoredIdentity" to (hasIdentity && hasMetadata))
        }

        AsyncFunction("loadStoredLocalUser") {
            val keystoreHelper = KeystoreHelper.getInstance(context)

            if (!keystoreHelper.isAuthenticated) {
                throw Exception("Must call authenticate() first")
            }

            // Load identity key pair from protected storage
            val identityKeyPairData = keystoreHelper.loadProtected(identityKeyPairStorageKey)
                ?: throw Exception("No stored identity key pair found. Call initializeIdentity first.")

            // Load metadata from standard encrypted storage
            val metadataBytes = keystoreHelper.load(localUserMetadataStorageKey)
                ?: throw Exception("Failed to load local user metadata")

            val metadata = org.json.JSONObject(String(metadataBytes, Charsets.UTF_8))
            val registrationId = metadata.getInt("registrationId")
            val deviceId = metadata.getInt("deviceId")
            val name = metadata.getString("name")
            val signedPreKeyRecordBase64 = metadata.getString("signedPreKeyRecord")
            val preKeysArray = metadata.getJSONArray("preKeys")
            val kyberPreKeysArray = metadata.getJSONArray("kyberPreKeys")

            // Initialize identity key pair
            val identityKeyPair = IdentityKeyPair(identityKeyPairData)

            // Initialize preKeys
            val preKeys = mutableListOf<PreKeyRecord>()
            for (i in 0 until preKeysArray.length()) {
                val obj = preKeysArray.getJSONObject(i)
                val id = obj.optInt("id", -1)
                val keyStr = obj.optString("key", "")
                if (id != -1 && keyStr != "") {
                    val keyData = Base64.decode(keyStr, Base64.NO_WRAP)
                    val preKeyRecord = PreKeyRecord(keyData)
                    preKeys.add(preKeyRecord)
                }
            }

            val signedPreKeyRecordData = Base64.decode(signedPreKeyRecordBase64, Base64.NO_WRAP)
            val signedPreKeyRecord = SignedPreKeyRecord(signedPreKeyRecordData)

            // Initialize kyber pre-keys
            val kyberPreKeys = mutableListOf<KyberPreKeyRecord>()
            for (i in 0 until kyberPreKeysArray.length()) {
                val obj = kyberPreKeysArray.getJSONObject(i)
                val id = obj.optInt("id", -1)
                val keyStr = obj.optString("key", "")
                if (id != -1 && keyStr != "") {
                    val keyData = Base64.decode(keyStr, Base64.NO_WRAP)
                    val kyberPreKeyRecord = KyberPreKeyRecord(keyData)
                    kyberPreKeys.add(kyberPreKeyRecord)
                }
            }

            // Initialize LocalUser
            val newLocalUser = LocalUser(
                identityKey = identityKeyPair,
                registrationId = registrationId.toUInt(),
                preKeys = preKeys,
                signedPreKey = signedPreKeyRecord,
                kyberPreKeys = kyberPreKeys,
                deviceId = deviceId.toUInt(),
                name = name
            )

            localUser = newLocalUser

            // H6/H7 FIX: Populate shared stores with local user's keys
            for (preKey in newLocalUser.preKeys) {
                sharedPreKeyStore?.storePreKey(preKey.id, preKey)
            }
            sharedSignedPreKeyStore?.storeSignedPreKey(newLocalUser.signedPreKey.id, newLocalUser.signedPreKey)
            for (kyberPreKey in newLocalUser.kyberPreKeys) {
                sharedKyberPreKeyStore?.storeKyberPreKey(kyberPreKey.id, kyberPreKey)
            }

            return@AsyncFunction mapOf("success" to true)
        }

        // ========== AES-256-GCM MEDIA ENCRYPTION ==========

        AsyncFunction("encryptAESGCM") { base64Data: String ->
            val data = Base64.decode(base64Data, Base64.NO_WRAP)

            val key = ByteArray(32)
            val iv = ByteArray(12)
            SecureRandom().nextBytes(key)
            SecureRandom().nextBytes(iv)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val keySpec = SecretKeySpec(key, "AES")
            val gcmSpec = GCMParameterSpec(128, iv) // 128-bit auth tag
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)

            // GCM appends the auth tag to the ciphertext automatically
            val encrypted = cipher.doFinal(data)

            return@AsyncFunction mapOf(
                "encryptedBase64" to Base64.encodeToString(encrypted, Base64.NO_WRAP),
                "keyBase64" to Base64.encodeToString(key, Base64.NO_WRAP),
                "ivBase64" to Base64.encodeToString(iv, Base64.NO_WRAP)
            )
        }

        AsyncFunction("decryptAESGCM") { encryptedBase64: String, keyBase64: String, ivBase64: String ->
            val encryptedData = Base64.decode(encryptedBase64, Base64.NO_WRAP)
            val key = Base64.decode(keyBase64, Base64.NO_WRAP)
            val iv = Base64.decode(ivBase64, Base64.NO_WRAP)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val keySpec = SecretKeySpec(key, "AES")
            val gcmSpec = GCMParameterSpec(128, iv)
            cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)

            val decrypted = cipher.doFinal(encryptedData)

            return@AsyncFunction Base64.encodeToString(decrypted, Base64.NO_WRAP)
        }
    }
}
