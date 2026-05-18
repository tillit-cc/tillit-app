package expo.modules.signalprotocol.stores

import android.app.KeyguardManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyStore
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class KeystoreHelper private constructor(private val context: Context) {

    companion object {
        @Volatile
        private var instance: KeystoreHelper? = null

        fun getInstance(context: Context): KeystoreHelper {
            return instance ?: synchronized(this) {
                instance ?: KeystoreHelper(context.applicationContext).also { instance = it }
            }
        }

        private const val PREFS_FILE_NAME = "com.tillit.signal.secure_prefs"
        // v1 (legacy): EncryptedSharedPreferences with a MasterKey that wasn't auth-bound.
        // Kept only for read-on-migration; new data is never written here.
        private const val PROTECTED_PREFS_FILE_NAME = "com.tillit.signal.protected_prefs"
        // v2: plain SharedPreferences. Each value is AES-GCM ciphertext encrypted with
        // a hardware-bound Keystore key that requires user authentication (biometric
        // or device credential) within the last 15 minutes. The plain SharedPreferences
        // is fine because the protection comes from the Keystore-bound cipher.
        private const val PROTECTED_PREFS_V2_FILE_NAME = "com.tillit.signal.protected_prefs_v2"
        private const val PROTECTED_KEY_ALIAS = "tillit_signal_protected_key"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val GCM_IV_SIZE = 12
        private const val GCM_TAG_BITS = 128
        private const val PROTECTED_AUTH_VALIDITY_SECONDS = 900 // 15 minuti

        // M4 FIX: Rate limiting for failed authentication attempts
        @Volatile
        private var failedAttempts = 0
        @Volatile
        private var lastFailedAttempt: Long = 0
        private const val MAX_ATTEMPTS = 5
        private const val LOCKOUT_DURATION_MS = 30_000L // 30 secondi

        fun resetRateLimiting() {
            failedAttempts = 0
            lastFailedAttempt = 0
        }
    }

    @Volatile
    private var _isAuthenticated = false

    // H1 FIX: Authentication timeout (15 minuti)
    @Volatile
    private var authenticationTimestamp: Long = 0
    private val authenticationTimeoutMs: Long = 900_000 // 15 minuti

    val isAuthenticated: Boolean
        get() = _isAuthenticated &&
                (System.currentTimeMillis() - authenticationTimestamp) < authenticationTimeoutMs

    // MARK: - Device Security Check

    fun isDeviceSecure(): Boolean {
        val keyguardManager = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return keyguardManager.isDeviceSecure
    }

    private val masterKey: MasterKey by lazy {
        val spec = KeyGenParameterSpec.Builder(
            MasterKey.DEFAULT_MASTER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()

        MasterKey.Builder(context)
            .setKeyGenParameterSpec(spec)
            .build()
    }

    private val encryptedPrefs: SharedPreferences by lazy {
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    // Legacy protected prefs (v1): kept for read-on-migration only. New writes go to v2.
    private val legacyProtectedPrefs: SharedPreferences by lazy {
        EncryptedSharedPreferences.create(
            context,
            PROTECTED_PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    // v2 protected prefs: plain SharedPreferences holding `iv || ciphertext` blobs
    // encrypted with a Keystore-bound AES key that requires user authentication.
    private val protectedPrefsV2: SharedPreferences by lazy {
        context.getSharedPreferences(PROTECTED_PREFS_V2_FILE_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Hardware-bound AES-256-GCM key. Authentication-gated:
     * - On API 30+ via `setUserAuthenticationParameters(900, BIOMETRIC_STRONG|DEVICE_CREDENTIAL)`
     * - On API 24..29 via `setUserAuthenticationValidityDurationSeconds(900)`
     *
     * Cipher.init throws `UserNotAuthenticatedException` if the user hasn't authenticated
     * via BiometricPrompt (or any KeyguardManager-recognised auth) within the last 15 minutes.
     * `setInvalidatedByBiometricEnrollment(false)` keeps the key alive across biometric
     * enrollment changes — equivalent to iOS `.userPresence` semantics, where passcode
     * remains a fallback.
     */
    private fun getOrCreateProtectedKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(PROTECTED_KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val specBuilder = KeyGenParameterSpec.Builder(
            PROTECTED_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            specBuilder.setUserAuthenticationParameters(
                PROTECTED_AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            specBuilder.setUserAuthenticationValidityDurationSeconds(PROTECTED_AUTH_VALIDITY_SECONDS)
        }

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        keyGenerator.init(specBuilder.build())
        return keyGenerator.generateKey()
    }

    private fun deleteProtectedKey() {
        try {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply {
                load(null)
                if (containsAlias(PROTECTED_KEY_ALIAS)) {
                    deleteEntry(PROTECTED_KEY_ALIAS)
                }
            }
        } catch (_: Exception) {
            // best effort
        }
    }

    // MARK: - Authentication

    fun authenticate(
        activity: FragmentActivity,
        reason: String = "Sblocca le chiavi di cifratura",
        callback: (Boolean, String?) -> Unit
    ) {
        // M4 FIX: Check rate limiting lockout
        if (failedAttempts >= MAX_ATTEMPTS) {
            val elapsed = System.currentTimeMillis() - lastFailedAttempt
            if (elapsed < LOCKOUT_DURATION_MS) {
                val remaining = (LOCKOUT_DURATION_MS - elapsed) / 1000
                callback(false, "TOO_MANY_ATTEMPTS: Wait ${remaining}s")
                return
            } else {
                // Lockout expired, reset counters
                failedAttempts = 0
                lastFailedAttempt = 0
            }
        }

        // First check if device is secure
        if (!isDeviceSecure()) {
            callback(false, "DEVICE_NOT_SECURE")
            return
        }

        val executor: Executor = ContextCompat.getMainExecutor(context)

        val biometricManager = BiometricManager.from(context)
        val canAuthenticate = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )

        if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
            callback(false, "AUTHENTICATION_NOT_AVAILABLE")
            return
        }

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Autenticazione richiesta")
            .setSubtitle(reason)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        val biometricPrompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    _isAuthenticated = true
                    // H1 FIX: Setta il timestamp di autenticazione
                    authenticationTimestamp = System.currentTimeMillis()
                    // M4 FIX: Reset rate limiting on success
                    failedAttempts = 0
                    lastFailedAttempt = 0
                    callback(true, null)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    _isAuthenticated = false
                    authenticationTimestamp = 0
                    // M4 FIX: Track failed attempt (error counts as failure)
                    failedAttempts++
                    lastFailedAttempt = System.currentTimeMillis()
                    callback(false, errString.toString())
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    // M4 FIX: Track each failed attempt
                    failedAttempts++
                    lastFailedAttempt = System.currentTimeMillis()
                }
            }
        )

        biometricPrompt.authenticate(promptInfo)
    }

    fun lock() {
        _isAuthenticated = false
        authenticationTimestamp = 0
    }

    fun requiresAuthentication(): Boolean {
        return !isAuthenticated
    }

    // H1 FIX: Reset del timer di autenticazione su attivita crittografica
    fun touchAuthentication() {
        if (_isAuthenticated) {
            authenticationTimestamp = System.currentTimeMillis()
        }
    }

    // MARK: - Encrypted Storage Operations

    fun save(key: String, data: ByteArray): Boolean {
        return try {
            val base64Data = Base64.encodeToString(data, Base64.NO_WRAP)
            encryptedPrefs.edit().putString(key, base64Data).commit()
        } catch (e: Exception) {
            false
        }
    }

    fun load(key: String): ByteArray? {
        return try {
            val base64Data = encryptedPrefs.getString(key, null) ?: return null
            Base64.decode(base64Data, Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    fun delete(key: String): Boolean {
        return try {
            encryptedPrefs.edit().remove(key).commit()
            true
        } catch (e: Exception) {
            false
        }
    }

    fun exists(key: String): Boolean {
        return encryptedPrefs.contains(key)
    }

    fun getAllKeys(): Set<String> {
        return encryptedPrefs.all.keys
    }

    fun deleteAll(prefix: String) {
        val keysToDelete = encryptedPrefs.all.keys.filter { it.startsWith(prefix) }
        val editor = encryptedPrefs.edit()
        keysToDelete.forEach { editor.remove(it) }
        editor.commit()

        // Also delete from both protected stores (v1 legacy + v2)
        val legacyKeys = legacyProtectedPrefs.all.keys.filter { it.startsWith(prefix) }
        val legacyEditor = legacyProtectedPrefs.edit()
        legacyKeys.forEach { legacyEditor.remove(it) }
        legacyEditor.commit()

        val v2Keys = protectedPrefsV2.all.keys.filter { it.startsWith(prefix) }
        val v2Editor = protectedPrefsV2.edit()
        v2Keys.forEach { v2Editor.remove(it) }
        v2Editor.commit()
    }

    // MARK: - Biometric-Protected Storage Operations (for identity keys)
    //
    // Storage strategy: AES-256-GCM ciphertext, key in AndroidKeyStore with
    // setUserAuthenticationRequired(true). Cipher.init throws
    // UserNotAuthenticatedException if the unlock window has expired —
    // we surface that as "not authenticated" (return false/null) so callers
    // re-prompt rather than silently fail.

    fun saveProtected(key: String, data: ByteArray): Boolean {
        if (!isAuthenticated) {
            return false
        }
        touchAuthentication()

        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateProtectedKey())
            val ciphertext = cipher.doFinal(data)
            val iv = cipher.iv

            val blob = ByteArray(iv.size + ciphertext.size)
            System.arraycopy(iv, 0, blob, 0, iv.size)
            System.arraycopy(ciphertext, 0, blob, iv.size, ciphertext.size)

            val base64Blob = Base64.encodeToString(blob, Base64.NO_WRAP)
            protectedPrefsV2.edit().putString(key, base64Blob).commit().also {
                // Once written to v2, drop any leftover legacy copy so we don't
                // end up with diverging data after partial migrations.
                if (legacyProtectedPrefs.contains(key)) {
                    legacyProtectedPrefs.edit().remove(key).commit()
                }
            }
        } catch (_: UserNotAuthenticatedException) {
            _isAuthenticated = false
            authenticationTimestamp = 0
            false
        } catch (_: Exception) {
            false
        }
    }

    fun loadProtected(key: String): ByteArray? {
        if (!isAuthenticated) {
            return null
        }
        touchAuthentication()

        // Try v2 first (new format: Keystore-bound AES-GCM)
        val v2 = readV2(key)
        if (v2 != null) {
            return v2
        }

        // Fallback to v1 legacy (EncryptedSharedPreferences without auth-gated key).
        // If found, re-save in v2 so subsequent reads are hardware-gated.
        val legacy = try {
            legacyProtectedPrefs.getString(key, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
        } catch (_: Exception) {
            null
        } ?: return null

        // Best-effort migration; even if save fails we still return the data so
        // the app keeps working — next read will retry the migration.
        saveProtected(key, legacy)
        return legacy
    }

    private fun readV2(key: String): ByteArray? {
        return try {
            val blob = protectedPrefsV2.getString(key, null)
                ?.let { Base64.decode(it, Base64.NO_WRAP) }
                ?: return null
            if (blob.size <= GCM_IV_SIZE) {
                return null
            }
            val iv = blob.copyOfRange(0, GCM_IV_SIZE)
            val ciphertext = blob.copyOfRange(GCM_IV_SIZE, blob.size)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val secretKey = getOrCreateProtectedKey()
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(ciphertext)
        } catch (_: UserNotAuthenticatedException) {
            _isAuthenticated = false
            authenticationTimestamp = 0
            null
        } catch (_: Exception) {
            null
        }
    }

    fun deleteProtected(key: String): Boolean {
        return try {
            protectedPrefsV2.edit().remove(key).apply()
            legacyProtectedPrefs.edit().remove(key).apply()
            true
        } catch (_: Exception) {
            false
        }
    }

    fun existsProtected(key: String): Boolean {
        return protectedPrefsV2.contains(key) || legacyProtectedPrefs.contains(key)
    }

    fun clearAll() {
        // Clear standard encrypted prefs
        encryptedPrefs.edit().clear().apply()

        // Clear both protected stores
        legacyProtectedPrefs.edit().clear().apply()
        protectedPrefsV2.edit().clear().apply()

        // Drop the Keystore-bound key so a fresh one is generated next time
        deleteProtectedKey()

        // Reset authentication state
        _isAuthenticated = false
        authenticationTimestamp = 0
    }
}
