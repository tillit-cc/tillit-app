import Foundation
import Security
import LocalAuthentication

enum KeychainError: Error, LocalizedError {
    case deviceNotSecure
    case authenticationFailed(String)

    var errorDescription: String? {
        switch self {
        case .deviceNotSecure:
            return "DEVICE_NOT_SECURE"
        case .authenticationFailed(let message):
            return message
        }
    }
}

/// KeychainHelper with hardware-enforced biometric ACL on protected items.
///
/// - LAYER 1 (Storage Security): Keychain protected items use
///   `SecAccessControl(.userPresence)` so iOS gates access at the kernel level —
///   reading requires an authenticated `LAContext`. Bypassing the app-level
///   `_isAuthenticated` flag (e.g. via a debugger) does NOT yield the data.
/// - LAYER 2 (App Authentication): `authenticate()` evaluates `LAContext` and
///   stores it; subsequent `loadProtected` calls pass that context to the
///   Keychain via `kSecUseAuthenticationContext`. Expires after `authenticationTimeout`.
/// - LAYER 3 (Migration): legacy items (saved with `kSecAttrAccessible` only,
///   no ACL) are migrated on first read after a successful unlock.
///
/// `save` / `load` (non-protected) retain `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
/// without ACL — they hold high-volume items (peer identities, sessions) that
/// are read on every message and cannot tolerate a biometric prompt.
class KeychainHelper {
    static let shared = KeychainHelper()

    private let service = "com.tillit.signal"
    private let protectedService = "com.tillit.signal.protected"

    // Authenticated LAContext kept for the duration of the unlock window.
    // Required by SecItemCopyMatching to read items protected with SecAccessControl.
    private var authContext: LAContext?

    private var _isAuthenticated = false
    private let queue = DispatchQueue(label: "com.tillit.signal.keychain")

    // Authentication timeout (15 minutes)
    private var authenticationTimestamp: Date?
    private let authenticationTimeout: TimeInterval = 900

    // Rate limiting for failed authentication attempts
    private static var failedAttempts = 0
    private static var lastFailedAttempt: Date?
    private static let maxAttempts = 5
    private static let lockoutDuration: TimeInterval = 30

    var isAuthenticated: Bool {
        return authenticatedContext() != nil
    }

    /// Returns the active LAContext if the unlock window is still valid,
    /// or nil if locked / expired. Lazy-invalidates expired state. Single
    /// `queue.sync` so callers don't race between an `isAuthenticated` check
    /// and a subsequent `authContext` read.
    private func authenticatedContext() -> LAContext? {
        return queue.sync {
            guard _isAuthenticated, let timestamp = authenticationTimestamp else {
                return nil
            }
            if Date().timeIntervalSince(timestamp) >= authenticationTimeout {
                authContext?.invalidate()
                authContext = nil
                _isAuthenticated = false
                authenticationTimestamp = nil
                return nil
            }
            return authContext
        }
    }

    private init() {}

    // MARK: - SecAccessControl helper

    private func makeAccessControl() -> SecAccessControl? {
        var error: Unmanaged<CFError>?
        // `.userPresence` accepts Face ID / Touch ID OR device passcode as fallback.
        // `WhenPasscodeSetThisDeviceOnly` ensures items never leave the device and
        // are unreadable if the user removes the passcode.
        let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .userPresence,
            &error
        )
        if error != nil {
            error?.release()
            return nil
        }
        return accessControl
    }

    // MARK: - Device Security Check

    func isDeviceSecure() -> Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    // MARK: - App Authentication (LAContext only - no keychain access)

    /// Authenticate user with Face ID/Touch ID or passcode.
    /// This only verifies the user identity - it does NOT access keychain items.
    /// After successful authentication, isAuthenticated becomes true.
    func authenticate(reason: String = "Sblocca le chiavi di cifratura", completion: @escaping (Bool, Error?) -> Void) {
        // M4 FIX: Check rate limiting lockout
        if let lastFailed = KeychainHelper.lastFailedAttempt,
           KeychainHelper.failedAttempts >= KeychainHelper.maxAttempts {
            let elapsed = Date().timeIntervalSince(lastFailed)
            if elapsed < KeychainHelper.lockoutDuration {
                let remaining = Int(KeychainHelper.lockoutDuration - elapsed)
                DispatchQueue.main.async {
                    completion(false, KeychainError.authenticationFailed("TOO_MANY_ATTEMPTS: Wait \(remaining)s"))
                }
                return
            } else {
                // Lockout expired, reset counters
                KeychainHelper.failedAttempts = 0
                KeychainHelper.lastFailedAttempt = nil
            }
        }

        // Check if device is secure
        guard isDeviceSecure() else {
            DispatchQueue.main.async {
                completion(false, KeychainError.deviceNotSecure)
            }
            return
        }

        // Authenticate the LAContext directly against the SecAccessControl that
        // protects our items. `evaluatePolicy(.deviceOwnerAuthentication)` is too
        // generic — on iOS 17/18 the Keychain re-prompts on every SecItemCopyMatching
        // call for items with `.userPresence` ACL even when `kSecUseAuthenticationContext`
        // is provided, because the context wasn't authenticated *against that ACL*.
        // `evaluateAccessControl(_, operation: .useItem, ...)` ties the unlock to the
        // exact ACL, so subsequent Keychain reads/writes don't prompt again.
        guard let accessControl = makeAccessControl() else {
            DispatchQueue.main.async {
                completion(false, KeychainError.authenticationFailed("ACL_CREATION_FAILED"))
            }
            return
        }

        let context = LAContext()
        context.evaluateAccessControl(accessControl, operation: .useItem, localizedReason: reason) { [weak self] success, authError in
            guard let self = self else { return }

            self.queue.sync {
                self._isAuthenticated = success
                if success {
                    self.authContext = context
                    self.authenticationTimestamp = Date()
                    // Reset rate limiting on success
                    KeychainHelper.failedAttempts = 0
                    KeychainHelper.lastFailedAttempt = nil
                } else {
                    self.authContext?.invalidate()
                    self.authContext = nil
                    self.authenticationTimestamp = nil
                    // Track failed attempt
                    KeychainHelper.failedAttempts += 1
                    KeychainHelper.lastFailedAttempt = Date()
                }
            }

            DispatchQueue.main.async {
                if success {
                    completion(true, nil)
                } else {
                    let errorMessage = self.parseAuthError(authError)
                    if errorMessage == "DEVICE_NOT_SECURE" {
                        completion(false, KeychainError.deviceNotSecure)
                    } else {
                        completion(false, KeychainError.authenticationFailed(errorMessage))
                    }
                }
            }
        }
    }

    private func parseAuthError(_ error: Error?) -> String {
        if let laError = error as? LAError {
            switch laError.code {
            case .userCancel:
                return "USER_CANCELED"
            case .authenticationFailed:
                return "AUTH_FAILED"
            case .passcodeNotSet:
                return "DEVICE_NOT_SECURE"
            default:
                return "AUTH_ERROR: \(laError.localizedDescription)"
            }
        }
        return error?.localizedDescription ?? "UNKNOWN_ERROR"
    }

    /// Lock the app - requires re-authentication to access protected data
    func lock() {
        queue.sync {
            authContext?.invalidate()
            authContext = nil
            _isAuthenticated = false
            authenticationTimestamp = nil
        }
    }

    func requiresAuthentication() -> Bool {
        return !isAuthenticated
    }

    // M4 FIX: Reset rate limiting (for testing or after successful unlock)
    static func resetRateLimiting() {
        failedAttempts = 0
        lastFailedAttempt = nil
    }

    // H1 FIX: Reset del timer di autenticazione su attività crittografica
    /// Chiamato automaticamente da loadProtected/saveProtected per mantenere la sessione attiva
    /// durante l'uso normale dell'app. Può anche essere chiamato esplicitamente.
    func touchAuthentication() {
        queue.sync {
            if _isAuthenticated {
                authenticationTimestamp = Date()
            }
        }
    }

    // MARK: - Protected Keychain Operations (for identity keys)
    //
    // Stored with SecAccessControl(.userPresence): reading requires an
    // authenticated LAContext, enforced by the Keychain Service at the kernel
    // level. Bypassing the in-process `_isAuthenticated` flag does not yield
    // the data — `kSecUseAuthenticationContext` must point to an LAContext
    // that has successfully evaluated `.deviceOwnerAuthentication`.

    func saveProtected(data: Data, for key: String) -> Bool {
        // Require an active unlock window — we never want to write protected
        // items without an LAContext, because (a) the SecItemAdd would either
        // fail or trigger an unexpected biometric prompt outside our flow, and
        // (b) callers should always have called `authenticate()` first.
        guard let context = authenticatedContext() else {
            return false
        }
        guard let accessControl = makeAccessControl() else {
            return false
        }

        // Delete existing item first (across both legacy and new formats)
        deleteProtected(for: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessControl as String: accessControl,
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
            // Bind the write to the currently-authenticated context so the
            // ACL evaluates "already satisfied" and SecItemAdd doesn't prompt.
            kSecUseAuthenticationContext as String: context
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    func loadProtected(for key: String) -> Data? {
        // Atomic check: returns the LAContext only if still unlocked.
        guard let context = authenticatedContext() else {
            #if DEBUG
            NSLog("[KeychainHelper] loadProtected(\(key)) failed: no authenticated context")
            #endif
            return nil
        }
        touchAuthentication()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService,
            kSecAttrAccount as String: key,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context
        ]

        var dataTypeRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)

        guard status == errSecSuccess, let data = dataTypeRef as? Data else {
            #if DEBUG
            NSLog("[KeychainHelper] loadProtected(\(key)) failed: OSStatus=\(status)")
            #endif
            return nil
        }

        // NOTE: items in `protectedService` are written exclusively by
        // `saveProtected`, which always attaches a `userPresence` SecAccessControl.
        // A read here means the item already carries the new ACL — re-saving on
        // first read each session is redundant. Some iOS releases also surface a
        // fresh biometric prompt on `SecItemAdd` for ACL items even with
        // `kSecUseAuthenticationContext`, so the migration re-save was producing
        // extra Face ID prompts at every cold start. True legacy migrations from
        // the non-protected `service` namespace happen one-shot in
        // `loadMetadata()` / `db/client.ts` via `load` + `saveProtected`.
        return data
    }

    @discardableResult
    func deleteProtected(for key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService,
            kSecAttrAccount as String: key
        ]

        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// Check if a protected key exists - NO biometric prompt
    ///
    /// On iOS 17/18 a `SecItemCopyMatching` against an item with a `userPresence`
    /// ACL triggers a Face ID / Touch ID prompt even when only attributes are
    /// requested. `kSecUseAuthenticationUI = kSecUseAuthenticationUISkip` tells
    /// the Keychain to fail rather than prompt.
    ///
    /// Robust existence test: the ONLY status that means "the item is not there"
    /// is `errSecItemNotFound`. Every other status — `errSecSuccess` (readable
    /// without auth), `errSecInteractionNotAllowed` (exists, locked behind
    /// biometric), `errSecAuthFailed`, etc. — means the item DOES exist, we just
    /// may not be able to read it without auth. The exact code for "exists but
    /// locked" varies across iOS versions, so we cannot enumerate them; we only
    /// special-case the unambiguous "not found".
    func existsProtected(for key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService,
            kSecAttrAccount as String: key,
            // Required: SecItemCopyMatching needs at least one kSecReturn* option
            // or it errors with errSecParam.
            kSecReturnAttributes as String: kCFBooleanTrue!,
            // Suppress the biometric prompt — see doc comment above.
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        let exists = status != errSecItemNotFound
        #if DEBUG
        NSLog("[KeychainHelper] existsProtected(\(key)) OSStatus=\(status) -> \(exists)")
        #endif
        return exists
    }

    // MARK: - Standard Keychain Operations (for other data)

    func save(data: Data, for key: String) -> Bool {
        delete(for: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            kSecAttrSynchronizable as String: kCFBooleanFalse!
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    func load(for key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var dataTypeRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)

        if status == errSecSuccess {
            return dataTypeRef as? Data
        }
        return nil
    }

    @discardableResult
    func delete(for key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]

        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    func exists(for key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnAttributes as String: kCFBooleanTrue!
        ]

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    // MARK: - Bulk Operations

    func deleteAll(withPrefix prefix: String) {
        // Delete from standard keychain
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        var result: AnyObject?
        var status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let items = result as? [[String: Any]] {
            for item in items {
                if let account = item[kSecAttrAccount as String] as? String,
                   account.hasPrefix(prefix) {
                    delete(for: account)
                }
            }
        }

        // Also delete from protected keychain
        let protectedQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService,
            kSecReturnAttributes as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        status = SecItemCopyMatching(protectedQuery as CFDictionary, &result)

        if status == errSecSuccess, let items = result as? [[String: Any]] {
            for item in items {
                if let account = item[kSecAttrAccount as String] as? String,
                   account.hasPrefix(prefix) {
                    deleteProtected(for: account)
                }
            }
        }
    }

    func getAllKeys() -> [String] {
        var keys: [String] = []

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let items = result as? [[String: Any]] {
            for item in items {
                if let account = item[kSecAttrAccount as String] as? String {
                    keys.append(account)
                }
            }
        }

        return keys
    }

    func clearAll() {
        // Delete all items from standard keychain
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        SecItemDelete(query as CFDictionary)

        // Delete all items from protected keychain
        let protectedQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: protectedService
        ]
        SecItemDelete(protectedQuery as CFDictionary)

        // Reset authentication state and invalidate the LAContext
        queue.sync {
            authContext?.invalidate()
            authContext = nil
            _isAuthenticated = false
            authenticationTimestamp = nil
        }
    }
}