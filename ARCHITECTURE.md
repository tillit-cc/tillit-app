# TilliT Native — Architettura e flussi

## Indice

1. [Entry point e routing](#1-entry-point-e-routing)
2. [Autenticazione](#2-autenticazione)
3. [Bootstrap dell'app](#3-bootstrap-dellapp)
4. [Signal Protocol — modulo nativo](#4-signal-protocol--modulo-nativo)
5. [Gestione sessioni](#5-gestione-sessioni)
6. [Flusso invio messaggi](#6-flusso-invio-messaggi)
7. [Flusso ricezione messaggi](#7-flusso-ricezione-messaggi)
8. [Crittografia di gruppo (Sender Keys)](#8-crittografia-di-gruppo-sender-keys)
9. [Socket](#9-socket)
10. [State management (Zustand)](#10-state-management-zustand)
11. [Database (SQLite + Drizzle)](#11-database-sqlite--drizzle)
12. [Lifecycle — background / foreground](#12-lifecycle--background--foreground)
13. [Gestione pre-key](#13-gestione-pre-key)
14. [Coda di retry](#14-coda-di-retry)
15. [Sicurezza](#15-sicurezza)
16. [API Endpoints](#16-api-endpoints)
17. [Logger diagnostico](#17-logger-diagnostico)
18. [Costanti di configurazione](#18-costanti-di-configurazione)
19. [Componenti UI](#19-componenti-ui)

---

## 1. Entry point e routing

**File:** `app/_layout.tsx`

Expo Router gestisce il routing dichiarativo. Il root layout legge lo stato di autenticazione dal `useAuthStore` e redireziona:

```
RootLayout()
  ├─ isLoading                          → splash screen
  ├─ !isDeviceSecure                    → /unsecure
  ├─ !isAuthenticated                   → /(auth)/login
  ├─ !isBiometricAuthenticated          → /locked
  └─ tutto ok                           → /(tabs)
```

**Screens:**

| Route | File | Descrizione |
|---|---|---|
| `/(auth)/login` | `app/(auth)/login.tsx` | Login / creazione identità |
| `/(tabs)/` | `app/(tabs)/index.tsx` | Lista chat (FlashList) |
| `/(tabs)/profile` | `app/(tabs)/profile.tsx` | Profilo utente |
| `/chat/[id]` | `app/chat/[id].tsx` | Schermata chat singola |
| `/locked` | `app/locked.tsx` | Sblocco biometrico |
| `/unsecure` | `app/unsecure.tsx` | Avviso dispositivo non sicuro |

---

## 2. Autenticazione

**File principali:**
- `app/(auth)/login.tsx` — UI di login
- `src/stores/auth.store.ts` — stato auth + challenge-response
- `src/hooks/useBiometricAuth.ts` — hook per biometria

### 2.1 Primo avvio (identità non presente)

```
login.tsx: checkIdentity()
  → SignalProtocol.hasStoredIdentity()          // controlla Keychain iOS
  → stato: 'not_found'

login.tsx: wipeAndCreate()
  → SignalProtocol.clearIdentity()              // pulisce Keychain
  → apiService.clearToken()                     // rimuove JWT
  → appInitService.clearAllIdentityData()       // svuota tutte le tabelle SQLite
  → SignalProtocol.authenticate(reason)          // Face ID / Touch ID
  → SignalProtocol.initializeIdentity(1, name)  // genera identity key pair,
                                                 // signed pre-key, pre-keys, kyber pre-keys
                                                 // salva chiavi private in Keychain
                                                 // ritorna PublicKeyBundle
  → authenticateWithBackend()                    // vedi sotto
  → syncPublicKeys()                             // upload bundle al server
```

### 2.2 Avvio successivo (identità presente)

```
login.tsx: checkIdentity()
  → SignalProtocol.hasStoredIdentity()
  → stato: 'found'

login.tsx: continueWithExisting()
  → SignalProtocol.authenticate(reason)          // sblocco biometrico
  → SignalProtocol.loadStoredLocalUser()         // carica chiavi dal Keychain
  → authenticateWithBackend()
  → syncPublicKeys()
```

### 2.3 Challenge-response (`auth.store.ts: authenticateWithBackend`)

```
authenticateWithBackend()
  1. SignalProtocol.getPublicIdentity()
       → { identityPublicKey, registrationId, deviceId }

  2. SignalProtocol.getSignedPreKeyInfo()
       → { id, publicKey, signature }

  3. apiService.requestChallenge(identityPublicKey)
       → POST /auth/challenge
       → { challengeId, nonce }

  4. SignalProtocol.signWithIdentityKey(nonce)
       → firma il nonce con la chiave privata (resta nel nativo)
       → { signature: challengeSignature }

  5. apiService.authenticateWithIdentity({
       identityPublicKey, registrationId, deviceId,
       signedPreKeyPublicKey, signedPreKeyId, signedPreKeySignature,
       challengeId, challengeSignature
     })
       → POST /auth/identity
       → { accessToken, userId, isNewUser }

  6. apiService.setToken(accessToken)
  7. SecureStore.setItemAsync('user_id', String(userId))
  8. SignalProtocol.setLocalUserId(String(userId))
```

### 2.4 Sblocco biometrico (`app/locked.tsx`)

Quando l'app torna in foreground dopo > 30 secondi:

```
locked.tsx: unlock()
  → SignalProtocol.authenticate('Sblocca TilliT')
  → authStore.setBiometricAuthenticated(true)
  → redirect → /(tabs)
```

---

## 3. Bootstrap dell'app

**File:** `src/services/app-init.service.ts`

Chiamato da `(tabs)/index.tsx` al mount. Ordine critico:

```
appInitService.initialize()
  │
  ├─ 1. chatService.recoverStuckMessages()
  │     → Marca SENDING/PENDING → FAILED (crash recovery)
  │
  ├─ 2. sessionService.loadSessions()
  │     → Carica sessioni Signal dal DB in memoria
  │
  ├─ 3. chatService.init()
  │     → Registra handler socket: onMessage, onPacket
  │     → PRIMA del connect, così onConnected trova gli handler pronti
  │
  ├─ 4. chatService.loadRooms()
  │     → Carica room dal DB nel chat store
  │     → PRIMA del connect, così onConnected fa rejoin delle room
  │
  ├─ 5. sessionService.initializePreKeyTracking()
  │     → Legge lastPreKeyId, lastKyberPreKeyId dal plugin nativo
  │     → Legge lastSignedPreKeyRotation da SecureStore
  │     → Cacha deviceId da getFullPublicBundle()
  │
  ├─ 6. loadProfile()
  │     → profileRepository.findByUser(userId)
  │     → Aggiorna username nello store
  │
  ├─ 7. socketService.connect()          // non bloccante se fallisce
  │     → onConnected() (vedi sotto)
  │
  ├─ 8. sessionService.refreshPreKeysIfNeeded()   // non bloccante
  │
  ├─ 9. registerPushToken()                        // non bloccante
  │     → expo-notifications → apiService.registerFirebaseToken()
  │
  └─ 10. setupLifecycleListeners()
         → AppState.addEventListener('change', handleAppStateChange)
         → socketService.onStateChange → appStore.setConnectionState
```

### 3.1 onConnected() — sync dopo connessione socket

**File:** `src/services/chat.service.ts: onConnected()`

Eseguito ogni volta che il socket raggiunge lo stato `CONNECTED` (primo avvio e riconnessioni). Protetto da `connectingLock` per evitare esecuzioni concorrenti.

```
chatService.onConnected()
  │
  ├─ 1. syncAllRoomsFromBackend()
  │     → GET /chat → lista room aggiornata dal server
  │     → roomRepository.upsert() per ogni room
  │     → loadRooms() → aggiorna store con metadata
  │
  ├─ 2. syncRoomMembersAndSessions()
  │     → Per ogni room: GET /chat/{id}/members
  │     → Se membro senza sessione → sessionService.setSession()
  │     → Invia SESSION_ESTABLISHED al nuovo membro
  │     → profileRepository.upsert() per ogni membro
  │
  ├─ 3. queueService.forceProcess()
  │     → Processa messaggi in coda (accodati offline)
  │
  ├─ 4. fetchPendingSenderKeysForAllRooms()
  │     → Per ogni room: initializeSenderKeysIfNeeded()
  │     → Se useSenderKeys: fetchAndProcessPendingSenderKeys()
  │
  ├─ 5. sessionService.refreshPreKeysIfNeeded()
  │     → Replenish pre-key / kyber pre-key sotto soglia
  │     → Rotazione signed pre-key se > 30 giorni
  │
  └─ 6. retrySendingMessages()
        → Cerca messaggi SENDING/PENDING < 2 ore
        → Re-encrypts con sessione corrente
        → Re-invia via socket
```

---

## 4. Signal Protocol — modulo nativo

**File:**
- `modules/signal-protocol/src/index.ts` — API JS
- `modules/signal-protocol/ios/SignalProtocolModule.swift` — implementazione Swift
- `modules/signal-protocol/ios/EncryptedSession.swift` — sessione crittografata
- `modules/signal-protocol/ios/Stores/` — store persistenti (Keychain)

### 4.1 Struttura interna (Swift)

```swift
class SignalProtocolModule {
    var localUser: LocalUser?                          // utente locale + chiavi
    var encryptedSessions: [String: EncryptedSession]  // sessioni per userId remoto
    var senderKeyStore: PersistentSenderKeyStore        // sender key (gruppo)
    var sharedPreKeyStore: PersistentPreKeyStore         // pre-key condivise
    var sharedSignedPreKeyStore: PersistentSignedPreKeyStore
    var sharedKyberPreKeyStore: PersistentKyberPreKeyStore
}
```

### 4.2 Operazioni principali

| Funzione | Descrizione |
|---|---|
| `initializeIdentity(deviceId, name)` | Genera identity key pair, signed pre-key, 100 pre-keys, 100 kyber pre-keys. Salva in Keychain. |
| `loadStoredLocalUser()` | Carica identity key pair e metadata dal Keychain |
| `hasStoredIdentity()` | Controlla se esiste un'identità nel Keychain |
| `authenticate(reason)` | Sblocco biometrico (LAContext) |
| `lock()` | Blocca accesso Keychain |
| `isAuthenticated()` | Verifica stato auth Keychain |
| `getPublicIdentity()` | Ritorna chiave pubblica, registrationId, deviceId |
| `getFullPublicBundle()` | Bundle completo per upload al server |
| `signWithIdentityKey(data)` | Firma dati con chiave privata identity |
| `setRemoteUserKeys(params)` | Salva chiavi pubbliche dell'utente remoto |
| `establishSession(remoteUserId)` | Crea sessione Signal con utente remoto |
| `resumeSession(userId, name, deviceId)` | Riprende sessione esistente |
| `encryptMessage(msg, remoteUserId)` | Crittografa messaggio (Double Ratchet) |
| `decryptMessage(msg, remoteUserId)` | Decrittografa messaggio |
| `clearIdentity()` | Pulisce TUTTO il Keychain (`KeychainHelper.clearAll()`) |

### 4.3 Flusso decrypt (Swift)

```
EncryptedSession.decrypt(message)
  1. Data(base64Encoded: message)
  2. Try: parse come SignalMessage → signalDecrypt()      // messaggio normale
  3. Catch: parse come PreKeySignalMessage
       → Verifica preKeyId nel store
       → Verifica signedPreKeyId nel store
       → signalDecryptPreKey()                           // primo messaggio (pre-key)
  4. return String(bytes: decryptedBytes, encoding: .utf8)
```

### 4.4 Storage nativo (Keychain)

**File:** `modules/signal-protocol/ios/Stores/KeychainHelper.swift`

Due service Keychain:
- `com.tillit.signal` — accesso senza biometria
- `com.tillit.signal.protected` — richiede Face ID / Touch ID (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`)

Store persistenti:
- `PersistentPreKeyStore` — pre-key one-time
- `PersistentSignedPreKeyStore` — signed pre-key
- `PersistentKyberPreKeyStore` — kyber pre-key (post-quantum)
- `PersistentIdentityKeyStore` — identity key remoti (trust)
- `PersistentSessionStore` — sessioni Signal Protocol
- `PersistentSenderKeyStore` — sender key (gruppo)

**Nota:** Il Keychain iOS persiste tra reinstallazioni dell'app. SQLite no.

---

## 5. Gestione sessioni

**File:** `src/services/session.service.ts`

### 5.1 Stabilire una sessione

```
sessionService.setSession(roomId, remoteUserId, username, deviceId)
  │
  ├─ Protezione self-session: skip se remoteUserId === ownUserId
  │
  ├─ Cerca sessione esistente: sessionRepository.findByUserAndRoom()
  │   └─ Se esiste → SignalProtocol.resumeSession(userId, name, deviceId)
  │
  └─ Se non esiste:
      1. apiService.getRemoteKeys(remoteUserId)
           → GET /keys/{userId}
           → { preKey, kyberPreKey, signedPreKey, identityPublicKey, registrationId }

      2. Validazione chiavi (presenza e formato)

      3. SignalProtocol.setRemoteUserKeys({
           remoteUserId, preKeyId, preKeyPublicKey,
           signedPreKeyId, signedPreKeyPublicKey, signedPreKeySignature,
           identityPublicKey, registrationId, deviceId,
           kyberPreKeyId, kyberPreKeyPublicKey, kyberPreKeySignature
         })

      4. SignalProtocol.establishSession(remoteUserId)

      5. sessionRepository.upsert({
           idUser, idRoom, remoteUserName, remoteUserDeviceId,
           identityVerified: 0, created, lastModified
         })

      6. Aggiorna cache in memoria: sessions Map<roomId, Session[]>
```

### 5.2 Ensure session (lazy)

```
sessionService.ensureSession(roomId, remoteUserId)
  → Cerca nella cache in memoria
  → Se non presente → setSession()
```

### 5.3 Recovery sessione

```
sessionService.recoverSession(roomId, remoteUserId, username)
  → Rimuove sessione dal DB: sessionRepository.delete()
  → Ricostruisce sessione: setSession()
```

---

## 6. Flusso invio messaggi

**File:** `src/services/chat.service.ts`

```
                          ┌─────────────┐
                          │  ChatScreen  │
                          │   onSend()   │
                          └──────┬───────┘
                                 │
                                 ▼
                   chatService.sendMessage(roomId, text, parentId)
                                 │
                                 ▼
              MessageEnvelopeFactory.createTextMessage()
              → genera UUID, timestamp, category='user', type='text'
                                 │
                                 ▼
                   chatService.sendEnvelope(envelope, plainBody)
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
              ▼                  ▼                   ▼
    store.addMessage()   messageRepository     encrypt(roomId, payload)
    (optimistico,        .create(message)           │
     status=SENDING)     (SQLite)             ┌─────┴──────┐
                                              │            │
                                              ▼            ▼
                                       useSenderKeys?   pair-wise
                                              │            │
                                              ▼            ▼
                                    senderKeyService   Per ogni sessione:
                                    .encryptWith-      sessionService.ensureSession()
                                     SenderKey()       SignalProtocol.encryptMessage()
                                              │            │
                                              └─────┬──────┘
                                                    │
                                                    ▼
                                      socketService.sendMessage()
                                      → emit('sendMessage', {...})
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                         ▼                     ▼
                                      Successo              Errore
                                         │                     │
                                         ▼                     ▼
                                  status → SENT        queueService.addMessage()
                                  (DB + store)          (retry con backoff)
```

### 6.1 Struttura envelope inviato al server

**Pair-wise:**
```json
{
  "id": "uuid",
  "timestamp": 1706000000,
  "category": "user",
  "type": "text",
  "payload": {
    "body": {
      "123": "base64_encrypted_for_user_123",
      "456": "base64_encrypted_for_user_456"
    }
  },
  "id_room": 1,
  "id_user_from": 789,
  "encrypted": true,
  "version": "2.0"
}
```

**Sender key:**
```json
{
  "id": "uuid",
  "category": "senderkey_message",
  "type": "text",
  "payload": {
    "ciphertext": "base64_encrypted",
    "distributionId": "uuid"
  },
  ...
}
```

---

## 7. Flusso ricezione messaggi

```
Server → socket.io 'newMessage' / 'newPacket'
              │
              ▼
    socketService: extractEnvelope(data)
              │
              ▼
    chatService.handleIncomingMessage(envelope)
              │
              ├─ Filtro self-echo:
              │   if id_user_from === userId && category !== 'system' → SKIP
              │
              ▼
        switch (envelope.category)
              │
    ┌─────────┼─────────┬──────────────┬────────────┐
    │         │         │              │            │
    ▼         ▼         ▼              ▼            ▼
  'user'   'senderkey  'control'    'system'    default
    │      _message'      │            │        → warn
    │         │           │            │
    ▼         ▼           ▼            ▼
```

### 7.1 Messaggi utente (`handleUserMessage`)

```
handleUserMessage(envelope, roomId)
  │
  ├─ 1. Deduplicazione: messageRepository.findById(envelope.id)
  │     → se esiste già → SKIP
  │
  ├─ 2. Estrai body crittografato: payload.body[userId]
  │
  ├─ 3. decrypt(encryptedBody, roomId, fromUserId)
  │     → SignalProtocol.decryptMessage(body, remoteUserId)
  │     → sessionService.ensureSessionInDatabase()
  │     → sessionService.updateSessionTimestamp()
  │     → return decodeURIComponent(decryptedMessage)
  │
  ├─ 4. JSON.parse(decrypted) → parsedPayload
  │     → extractUserBody(type, payload) → testo leggibile
  │
  ├─ 5. messageRepository.create({
  │       id, type, body, encryptedBody, idRoom, idUserFrom,
  │       idStatus: isViewingRoom ? READ : DELIVERED
  │     })
  │
  ├─ 6. useChatStore.addMessage(roomId, message)
  │
  ├─ 7. updateRoomAfterMessage(roomId, body)
  │
  ├─ 8. sendControlPacket(MESSAGE_DELIVERED)
  │
  └─ 9. Se viewing room → sendControlPacket(MESSAGE_READ)
```

### 7.2 Messaggi sender key (`handleSenderKeyMessage`)

```
handleSenderKeyMessage(envelope, roomId)
  │
  ├─ 1. Deduplicazione
  ├─ 2. senderKeyService.decryptWithSenderKey(roomId, senderUserId, ciphertext)
  │     → SignalProtocol.decryptGroupMessage(ciphertext, roomId, senderId)
  ├─ 3. Parse + save (come messaggi utente)
  └─ 4. Receipts DELIVERED / READ
```

### 7.3 Control packet (`handleControlPacket`)

```
handleControlPacket(envelope, roomId)
  │
  ├─ Decrypt (se encrypted):
  │   ├─ Sender key → senderKeyService.decryptWithSenderKey()
  │   └─ Pair-wise → decrypt(encryptedBody, roomId, fromUserId)
  │
  └─ processControlPacket(type, payload, roomId, fromUserId)
       │
       ├─ MESSAGE_DELIVERED → messageRepository.updateStatus(DELIVERED)
       ├─ MESSAGE_READ      → messageRepository.updateStatus(READ)
       ├─ PROFILE_UPDATED   → profileRepository.upsert(username)
       └─ SESSION_ESTABLISHED → handleSessionEstablishedWithLock()
            → Lock per (roomId, fromUserId) per evitare race condition
            → sessionService.setSession() se non già stabilita
            → Se reply: invia SESSION_ESTABLISHED di risposta
```

### 7.4 Messaggi di sistema (`handleSystemMessage`)

```
handleSystemMessage(envelope, roomId)
  │
  ├─ 'user_joined'  → profileRepository.upsert()
  ├─ 'user_left'    → log
  ├─ 'room_deleted' → roomRepository.delete() + store.removeRoom()
  └─ 'room_renamed' → roomRepository.update() + store.updateRoom()
```

### 7.5 Gestione errori decrypt

```
decrypt() catch:
  │
  ├─ Errore 12 (UntrustedIdentity — possibile MITM):
  │   → sessionService.handleIdentityKeyChanged()
  │   → return false (messaggio non salvato)
  │
  ├─ Errore 11 (invalidKey — pre-key mancante):
  │   → sessionService.recoverSession()
  │   → sessionService.refreshPreKeysIfNeeded() (non bloccante)
  │   → return false (messaggio perso, sessione recuperata per futuri)
  │
  └─ Errore 6 (InvalidMessage):
      → NON fare recoverSession (creerebbe una NUOVA sessione e tutti
        i messaggi in-flight cifrati con la sessione vecchia fallirebbero)
      → Log warning e return false
      → La sessione potrebbe essere ancora valida per messaggi successivi
```

### 7.6 Gestione errori sender key decrypt

```
handleSenderKeyMessage() catch:
  │
  └─ Errore 19 (No sender key state):
      → senderKeyService.fetchAndProcessPendingSenderKeys(roomId)
      → Retry decrypt (una sola volta, retryCount = 1)
      → Se ancora fallisce → log error, messaggio perso
```

---

## 8. Crittografia di gruppo (Sender Keys)

**File:** `src/services/sender-key.service.ts`

Attivata per room con ≥ 4 membri (`SENDER_KEY_THRESHOLD = 4`).

### 8.1 Inizializzazione

```
senderKeyService.initializeSenderKeys(roomId, memberIds)
  │
  ├─ 1. apiService.post('sender-keys/initialize/{roomId}')
  │     → { distributionId }
  │
  ├─ 2. SignalProtocol.createSenderKeySession(roomId, distributionId)
  │     → { distributionMessage, distributionId }
  │
  ├─ 3. senderKeyRepository.upsertSession({
  │       idRoom, senderUserId, distributionId, chainVersion: 1, messageCount: 0
  │     })
  │
  └─ 4. distributeSenderKey(roomId, distributionId, distributionMessage, memberIds)
         Per ogni membro:
           → Ensure pair-wise session
           → SignalProtocol.encryptMessage(distributionMessage, memberId)
         → apiService.uploadSenderKeyDistribution(roomId, distributions)
```

### 8.2 Ricezione sender key

```
fetchAndProcessPendingSenderKeys(roomId)
  │
  ├─ 1. apiService.fetchPendingSenderKeys(roomId)
  │     → { distributions: [...] }
  │
  ├─ 2. Per ogni distribution:
  │     → SignalProtocol.decryptMessage(encryptedSenderKey, senderId)
  │     → SignalProtocol.processSenderKeyDistribution(roomId, senderId, distributionMessage)
  │     → senderKeyRepository.upsertSession({...})
  │
  └─ 3. apiService.post('sender-keys/mark-delivered', { distributionIds })
```

### 8.3 Rotazione

- Ogni 1000 messaggi (`MESSAGE_ROTATION_THRESHOLD`)
- Ogni 7 giorni (`DAYS_ROTATION_THRESHOLD`)
- Quando un membro lascia la room (forward secrecy)

```
rotateSenderKey(roomId, memberIds)
  → apiService.post('sender-keys/rotate/{roomId}')
  → SignalProtocol.rotateSenderKey(roomId)
  → distributeSenderKey() con il nuovo distributionId
```

---

## 9. Socket

**File:** `src/services/socket.service.ts`

### 9.1 Connessione

```
socketService.connect()
  → apiService.getToken()
  → io(`${socketUrl}/chat`, {
      transports: ['websocket'],
      auth: { token: 'Bearer ...' },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000 → 60000 (backoff)
    })
  → attachListeners()
  → socket.connect()
```

### 9.2 Eventi

| Evento | Direzione | Descrizione |
|---|---|---|
| `sendMessage` | Client → Server | Invia messaggio |
| `sendPacket` | Client → Server | Invia control packet |
| `joinRoom` | Client → Server | Entra in una room |
| `leaveRoom` | Client → Server | Esce da una room |
| `newMessage` | Server → Client | Nuovo messaggio ricevuto |
| `newPacket` | Server → Client | Nuovo control packet ricevuto |
| `senderKeysAvailable` | Server → Client | Sender key disponibili |
| `userOnline` | Server → Client | Stato online utente |

### 9.3 Riconnessione

- Automatica (socket.io built-in)
- Backoff esponenziale: 1s → 60s max
- Max 10 tentativi
- Su errore auth → disconnessione immediata (no retry)
- Su foreground → riconnessione manuale se disconnesso

---

## 10. State management (Zustand)

### 10.1 Auth Store (`src/stores/auth.store.ts`)

```typescript
{
  isAuthenticated: boolean
  isBiometricAuthenticated: boolean
  isDeviceSecure: boolean
  isLoading: boolean
  userId: number | null
  identityState: 'checking' | 'found' | 'not_found' | 'creating'

  // Actions
  loadStoredToken()                // Carica JWT da SecureStore
  authenticateWithBackend()        // Challenge-response con server
  setBiometricAuthenticated(v)     // Dopo sblocco biometrico
  logout()                         // Reset completo
}
```

### 10.2 App Store (`src/stores/app.store.ts`)

```typescript
{
  connectionState: SocketConnectionState
  isInBackground: boolean
  lastActiveTimestamp: number
  securityAlerts: SecurityAlert[]
  settings: { username, notificationsEnabled, darkMode }

  // Actions
  setConnectionState(state)
  setInBackground(v)
  addSecurityAlert(alert)           // Identity key changed
  updateSettings(partial)
}
```

### 10.3 Chat Store (`src/stores/chat.store.ts`)

Usa **Immer** per aggiornamenti immutabili con sintassi mutabile.

```typescript
{
  currentRoomId: number | null
  currentUserId: number | null
  messages: Map<roomId, Message[]>
  profiles: Map<roomId, Map<userId, Profile>>
  rooms: Map<roomId, RoomWithMetadata>
  allRooms: RoomWithMetadata[]
  paginationState: Map<roomId, PaginationState>

  // Actions
  setCurrentRoom(id)
  setAllRooms(rooms)
  addMessage(roomId, message)         // Aggiunge + ricalcola metadata
  updateMessage(roomId, id, updates)  // Aggiorna status/body
  setMessages(roomId, messages)       // Bulk load da DB
  addRoomToList(room)
  updateRoomInList(roomId, updates)
  removeRoomFromList(roomId)
  clearAll()
}
```

**Message metadata** (calcolata per ogni messaggio):
- `showHeader` — mostra avatar/nome (utente diverso, gap > 5min, giorno diverso)
- `showDateSeparator` — separatore data tra giorni
- `username` — nome utente (o false se è il proprio o chat 1-on-1)
- `time` — orario formattato (HH:MM)
- `dateText` — data formattata (Oggi / Ieri / dd/mm/yyyy)

Date cache esterna a Immer per evitare freeze errors.

---

## 11. Database (SQLite + Drizzle)

**File:**
- `src/db/schema.ts` — definizione tabelle
- `src/db/client.ts` — connessione (`expo-sqlite` + `drizzle-orm`)
- `src/db/repositories/` — CRUD per ogni tabella

**Database:** `tillit.db` (creato con `CREATE TABLE IF NOT EXISTS`)

### 11.1 Tabelle

| Tabella | Descrizione | Chiave |
|---|---|---|
| `message` | Messaggi crittografati e decriptati | `id` (UUID) |
| `room` | Chat rooms | `id` (integer PK) |
| `profile` | Profili utente per room | `id` (auto), unique(idUser, idRoom) |
| `session` | Metadata sessioni Signal | `id` (auto), unique(idUser, idRoom) |
| `identity` | Metadata identità locale | `registrationId` |
| `sender_key_session` | Metadata sender key | `id` (auto), unique(idRoom, senderUserId) |
| `sender_key_retry_queue` | Retry distribuzione sender key | `id` (auto) |

### 11.2 Message status

```
FAILED  = -1
PENDING =  0
SENDING =  1
SENT    =  2
DELIVERED = 3
READ    =  4
```

### 11.3 Repository principali

**messageRepository:**
- `create(message)` — inserisce messaggio
- `findById(id)` — lookup per deduplicazione
- `findByRoom(roomId, { limit, beforeTimestamp })` — paginazione
- `updateStatus(id, status)` — aggiorna stato
- `findByStatus(status)` — per crash recovery
- `updateAllByStatus(from, to)` — bulk update (recovery)

**sessionRepository:**
- `upsert(session)` — crea o aggiorna sessione
- `findByRoom(roomId)` — tutte le sessioni di una room
- `findByUserAndRoom(userId, roomId)` — sessione specifica
- `delete(id)` — rimuove sessione (per recovery)

**roomRepository:**
- `upsert(room)` — crea o aggiorna room
- `findById(id)` — lookup
- `findAllWithMetadata()` — tutte le room con metadata (JOIN)
- `delete(id)` — rimuove room

---

## 12. Lifecycle — background / foreground

**File:** `src/services/app-init.service.ts: handleAppStateChange()`

### 12.1 App va in background

```
AppState → 'background' | 'inactive'
  │
  ├─ Salva timestamp: lastBackground = Date.now()
  ├─ appStore.setInBackground(true)
  └─ SignalProtocol.lock()
       → Blocca accesso Keychain (richiederà biometria al rientro)
```

### 12.2 App torna in foreground

```
AppState → 'active'
  │
  ├─ appStore.setInBackground(false)
  ├─ appStore.updateLastActiveTimestamp()
  │
  ├─ Se elapsed > 30s (LOCK_TIMEOUT):
  │   → SignalProtocol.isAuthenticated()
  │   → Se non autenticato → authStore.setBiometricAuthenticated(false)
  │     → Redirect a /locked
  │
  ├─ Se socket disconnesso:
  │   → socketService.connect()
  │
  └─ sessionService.refreshPreKeysIfNeeded()
       → Controlla soglia pre-key + rotazione signed pre-key
```

---

## 13. Gestione pre-key

**File:** `src/services/session.service.ts`

### 13.1 Parametri

```
PREKEY_THRESHOLD     = 10    // sotto questa soglia → replenish
PREKEY_BATCH_SIZE    = 50    // quante generare per batch
SIGNED_PREKEY_ROTATE_DAYS = 30   // ogni 30 giorni
```

### 13.2 Refresh pre-keys

```
sessionService.refreshPreKeysIfNeeded()
  │
  ├─ replenishPreKeys()
  │   → SignalProtocol.getFullPublicBundle()
  │   → Se preKeys.length < PREKEY_THRESHOLD:
  │       → SignalProtocol.replenishPreKeys(lastPreKeyId + 1, PREKEY_BATCH_SIZE)
  │       → apiService.syncPublicKeys(bundle)
  │       → Aggiorna lastPreKeyId
  │
  ├─ replenishKyberPreKeys()
  │   → Stessa logica per kyber pre-keys
  │
  └─ rotateSignedPreKeyIfNeeded()
      → Se sono passati > 30 giorni dalla ultima rotazione:
          → SignalProtocol.rotateSignedPreKey()
          → apiService.syncPublicKeys(bundle)
          → SecureStore.setItemAsync('last_signed_prekey_rotation', timestamp)
```

### 13.3 Tracking IDs

- `lastPreKeyId` — letto dal bundle nativo (`getFullPublicBundle`)
- `lastKyberPreKeyId` — idem
- `lastSignedPreKeyRotation` — salvato in `expo-secure-store` (persiste nel Keychain)
- `deviceId` — cached dal bundle nativo

---

## 14. Coda di retry

**File:** `src/services/queue.service.ts`

```
queueService
  │
  ├─ messageQueue: QueuedMessage[]       // in memoria
  ├─ isProcessing: boolean
  ├─ processorInterval: 5s
  │
  ├─ addMessage(envelope, callbacks)
  │   → Aggiunge alla coda con retryCount: 0, maxRetries: 5
  │
  ├─ forceProcess()
  │   → Chiamato da onConnected() dopo riconnessione
  │
  └─ processQueue()
      → Per ogni messaggio in coda:
        → Se socket connesso:
            → socketService.sendMessage()
            → Se successo: callbacks.onSuccess()
            → Se errore:
                → retryCount++
                → Se retryCount >= maxRetries: callbacks.onError()
        → Backoff: 2^retryCount * 1000ms (max 60s)
```

**Nota:** La coda è in memoria. In caso di crash, `recoverStuckMessages()` al bootstrap marca i messaggi bloccati come FAILED.

---

## 15. Sicurezza

### 15.1 Protezione chiavi private

- Chiavi private **mai** esposte al layer JavaScript
- Salvate in **iOS Keychain** con `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
- Biometria richiesta per accesso

### 15.2 Crittografia end-to-end

- **Pair-wise (< 4 utenti):** Signal Protocol Double Ratchet
  - Forward secrecy per messaggio
  - Pre-key per prima comunicazione
- **Gruppo (≥ 4 utenti):** Sender Keys
  - Un'unica chiave di gruppo per mittente
  - Rotazione periodica (1000 msg / 7 giorni / membro uscito)
- **Post-quantum:** Kyber pre-keys (ibride) per resistenza quantistica

### 15.3 Verifica identità

- Safety numbers per verifica out-of-band
- Rilevamento cambio identity key (errore 12 → alert di sicurezza)
- Flag `identityVerified` per sessione

### 15.4 Protezione dispositivo

- `SignalProtocol.checkDeviceSecurity()` — verifica passcode/biometria
- Schermata `/unsecure` se il dispositivo non è protetto

### 15.5 Lock automatico

- App in background > 30s → richiede sblocco biometrico
- Keychain bloccato in background (`SignalProtocol.lock()`)

### 15.6 Cleanup dati

```
appInitService.clearAllIdentityData()
  → DELETE FROM: identity, session, sender_key_session,
    sender_key_retry_queue, message, room, profile

SignalProtocol.clearIdentity()
  → KeychainHelper.clearAll()
  → Rimuove TUTTI gli item Keychain (entrambi i service)
```

---

## 16. API Endpoints

**File:** `src/services/api.service.ts`

Base URL: `EXPO_PUBLIC_API_URL` (default `https://api.tillit.cc`).
Autenticazione: header `Authorization: Bearer <JWT>` (interceptor automatico).

### 16.1 Auth

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/auth/challenge` | Richiede nonce per challenge-response |
| POST | `/auth/identity` | Autentica con firma del nonce → JWT |
| POST | `/auth/token/push` | Registra push token (Expo/FCM) |

### 16.2 Chat / Room

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/chat` | Lista tutte le room dell'utente |
| PUT | `/chat` | Crea nuova room |
| POST | `/chat/{inviteCode}` | Entra in una room via codice invito |
| PUT | `/chat/{roomId}` | Aggiorna room (nome) |
| DELETE | `/chat/{roomId}` | Elimina room (solo creatore) |
| GET | `/chat/{roomId}/members` | Lista membri della room |
| PUT | `/chat/{roomId}/profile` | Aggiorna profilo utente nella room |
| GET | `/chat/{roomId}/metadata` | Metadata della room |

### 16.3 Keys

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/keys` | Upload public key bundle (pre-keys, signed, kyber) |
| GET | `/keys/status/self` | Stato delle proprie chiavi sul server |
| GET | `/keys/{userId}` | Scarica chiavi pubbliche di un utente remoto |

### 16.4 Sender Keys

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `sender-keys/initialize/{roomId}` | Inizializza sender key per la room → `{ distributionId }` |
| POST | `sender-keys/distribute/{roomId}` | Upload sender key cifrate per ogni membro |
| GET | `sender-keys/{roomId}` | Scarica sender key pendenti |
| POST | `sender-keys/mark-delivered` | Marca sender key come ricevute |
| POST | `sender-keys/rotate/{roomId}` | Rotazione sender key |

---

## 17. Logger diagnostico

**File:** `src/utils/logger.ts`

### 17.1 Funzionamento

Il logger scrive su due canali:
1. **Console** — sempre attivo (`console.log`, `console.warn`, `console.error`)
2. **Zustand store** — `useAppStore.addConnectionLog()` (controllato da flag `STORE_LOGGING_ENABLED`)

```typescript
import { logger } from '@/utils/logger';

logger.info('messaggio');   // → console.log + store
logger.warn('attenzione');  // → console.warn + store
logger.error('errore');     // → console.error + store
```

### 17.2 Store log

- Le entry vengono salvate in `app.store.ts: connectionLog[]`
- Limite: **200 entry** (FIFO, le più vecchie vengono scartate)
- Formato: `[HH:MM:SS] messaggio`
- Visibili nella **ServerStatusModal** (accessibile con 10-tap sull'icona di connessione)

### 17.3 Convenzione

Tutti i servizi usano il logger con prefisso tra parentesi quadre:
- `[ChatService]`, `[Socket]`, `[AppInit]`, `[SenderKey]`, `[SessionService]`

---

## 18. Costanti di configurazione

### 18.1 File `src/config/app.config.ts`

| Costante | Valore | Env override | Descrizione |
|---|---|---|---|
| `SENDER_KEY_THRESHOLD` | 4 | `EXPO_PUBLIC_SENDER_KEY_THRESHOLD` | Membri minimi per attivare sender keys |
| `SENDER_KEY_MESSAGE_ROTATION_THRESHOLD` | 1000 | `EXPO_PUBLIC_SENDER_KEY_MESSAGE_ROTATION` | Messaggi prima della rotazione sender key |
| `SENDER_KEY_DAYS_ROTATION_THRESHOLD` | 7 giorni (in sec) | `EXPO_PUBLIC_SENDER_KEY_DAYS_ROTATION` | Giorni prima della rotazione sender key |

### 18.2 File `src/services/session.service.ts`

| Costante | Valore | Descrizione |
|---|---|---|
| `PREKEY_THRESHOLD` | 10 | Sotto questa soglia → replenish pre-keys |
| `PREKEY_BATCH_SIZE` | 50 | Pre-keys generate per batch |
| `SIGNED_PREKEY_ROTATE_DAYS` | 30 | Giorni prima della rotazione signed pre-key |
| `REFRESH_THROTTLE_MS` | 60000 (60s) | Intervallo minimo tra refresh pre-keys |

### 18.3 File `src/services/app-init.service.ts`

| Costante | Valore | Descrizione |
|---|---|---|
| `LOCK_TIMEOUT` | 30000 (30s) | Tempo in background prima di richiedere biometria |

### 18.4 File `src/services/queue.service.ts`

| Costante | Valore | Descrizione |
|---|---|---|
| `processorInterval` | 5s | Intervallo di processamento coda |
| `maxRetries` | 5 | Tentativi massimi per messaggio |
| Backoff | 2^retryCount × 1000ms (max 60s) | Backoff esponenziale |

### 18.5 File `src/services/chat.service.ts`

| Costante | Valore | Descrizione |
|---|---|---|
| `MAX_RETRY_AGE_MS` | 2 ore | Messaggi stuck più vecchi → FAILED |
| Dedup cleanup | 5s (`setTimeout`) | Durata del lock in-memory per dedup |

### 18.6 Altre costanti

| Costante | Posizione | Valore | Descrizione |
|---|---|---|---|
| `MAX_MESSAGES` | `chat.store.ts` | 200 | Messaggi massimi in memoria per room |
| `connectionLog` limit | `app.store.ts` | 200 | Entry log massime nello store |

---

## 19. Componenti UI

**Directory:** `src/components/`

### 19.1 Chat (`src/components/chat/`)

| Componente | Descrizione |
|---|---|
| `ChatList.tsx` | Lista messaggi (FlashList) con paginazione, scroll-to-bottom, separatori data |
| `MessageBubble.tsx` | Bolla messaggio: testo, immagini, stato (sent/delivered/read), reply |
| `MessageBar.tsx` | Barra input: testo, allegati, invio |
| `RoomListItem.tsx` | Riga nella lista room: avatar, ultimo messaggio, unread count, timestamp |

### 19.2 Modali (`src/components/modals/`)

| Componente | Descrizione |
|---|---|
| `InvitationModal.tsx` | Crea room / unisciti via codice invito |
| `RoomDetailsModal.tsx` | Dettagli room: nome, membri, codice invito, elimina |
| `AttachmentModal.tsx` | Selezione allegati: fotocamera, galleria, file |
| `ImageViewerModal.tsx` | Visualizzazione immagini a schermo intero (pinch-to-zoom) |
| `ServerStatusModal.tsx` | Diagnostica: stato connessione, log (accessibile con 10-tap) |

### 19.3 UI base (`src/components/ui/`)

| Componente | Descrizione |
|---|---|
| `Button.tsx` | Bottone con varianti (primary, secondary, danger, ghost) |
| `Input.tsx` | Campo di input con label, errore, icone |
| `Avatar.tsx` | Avatar utente con iniziali e colore generato |
| `ConnectionStatusIcon.tsx` | Icona stato connessione (header tabs). 10-tap → ServerStatusModal |
