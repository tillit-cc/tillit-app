# TilliT Native

> **IMPORTANTE:** Questo file deve essere aggiornato dopo ogni modifica strutturale o che impatta sulla logica dell'app (nuove feature, nuovi file/componenti, cambiamenti architetturali, modifiche ai flussi, nuove dipendenze, nuove route). Mantenerlo allineato al codice è fondamentale per garantire contesto accurato nelle sessioni future.

## Overview

TilliT è un'app di messaggistica sicura con crittografia end-to-end basata sul Signal Protocol. Supporta chat 1-to-1 e di gruppo con strategie di crittografia adattive (pair-wise per <4 membri, sender keys per ≥4 membri).

## Tech Stack

- **Expo** v54 con **React Native** v0.81
- **Expo Router** v6 (file-based routing)
- **NativeWind** v4 (Tailwind CSS per React Native)
- **Zustand** v5 con middleware Immer
- **Drizzle ORM** + **expo-sqlite** (SQLite locale)
- **Socket.IO Client** v4 (messaggistica real-time)
- **Axios** (HTTP client)
- **Signal Protocol** (modulo nativo custom in `/modules/signal-protocol`)
- **expo-secure-store** (iOS Keychain / Android Keystore)
- **react-native-gesture-handler** v2.28 (gesture native, Pan gesture per swipe-to-reply)
- **react-native-reanimated** v4.1 (animazioni su UI thread)
- **expo-haptics** (feedback aptico)
- **expo-share-intent** (ricezione immagini da Share Extension / Share Intent)
- **Tor Proxy** (modulo nativo custom in `/modules/tor-proxy` — Tor embedded per server `.onion`)

## Struttura del progetto

```
app/                          # Routing (Expo Router, file-based)
├── _layout.tsx               # Root layout con logica auth redirect + GestureHandlerRootView
├── +native-intent.ts         # Intercetta deep link e share intent prima del routing
├── (auth)/login.tsx          # Schermata di login
├── (tabs)/                   # Tab navigation principale
│   ├── _layout.tsx           # Layout tabs
│   ├── index.tsx             # Lista chat
│   └── profile.tsx           # Profilo utente
├── chat/[id].tsx             # Dettaglio chat
├── join-room.tsx             # Join room via invite code (deep link)
├── share-target.tsx          # Condivisione immagini da app esterne
├── locked.tsx                # Sblocco biometrico
└── unsecure.tsx              # Avviso dispositivo non sicuro

src/
├── components/               # Componenti UI riutilizzabili
│   ├── chat/                 # ChatList, MessageBubble, MessageBar, RoomListItem,
│   │                         # SwipeableMessage
│   ├── modals/               # InvitationModal, RoomDetailsModal, AttachmentModal,
│   │                         # ImageViewerModal, EphemeralImageViewerModal, ServerStatusModal
│   └── ui/                   # Button, Input, Avatar, ConnectionStatusIcon
├── config/
│   └── app.config.ts         # Costanti configurabili (soglie, threshold)
├── stores/                   # State management (Zustand)
│   ├── auth.store.ts         # Stato autenticazione e identità
│   ├── chat.store.ts         # Rooms, messaggi, profili
│   └── app.store.ts          # Stato connessione, settings, log diagnostici
├── services/                 # Logica di business
│   ├── api.service.ts        # HTTP client con gestione token
│   ├── chat.service.ts       # Core: routing messaggi, encrypt/decrypt (~1550 righe)
│   ├── socket.service.ts     # Socket.IO con auto-reconnect
│   ├── session.service.ts    # Gestione sessioni Signal Protocol
│   ├── sender-key.service.ts # Crittografia di gruppo (sender keys)
│   ├── queue.service.ts      # Coda messaggi offline con retry
│   └── app-init.service.ts   # Bootstrap post-autenticazione
├── db/
│   ├── schema.ts             # Schema SQLite (Drizzle): messages, rooms, profiles, sessions, etc.
│   ├── client.ts             # Connessione expo-sqlite + Drizzle
│   └── repositories/         # CRUD per ogni tabella (message, room, profile, session, sender-key)
├── hooks/                    # Custom React hooks
├── utils/
│   └── logger.ts             # Logger diagnostico (console + Zustand store)
└── types/                    # Tipi TypeScript (message, envelope, control packet)

modules/
├── signal-protocol/          # Modulo nativo Signal Protocol (Expo module)
├── secure-view/              # Modulo nativo SecureView (screenshot protection)
└── tor-proxy/                # Modulo nativo Tor embedded (HTTP + WebSocket via SOCKS5)

constants/
└── theme.ts                  # Tema e colori dell'app
```

## Architettura

### Flusso di autenticazione

```
App Start → Check device security
  ├─ Non sicuro → /unsecure
  ├─ Sicuro → loadStoredToken()
  │   ├─ Token default valido → isAuthenticated=true
  │   ├─ Token scaduto/assente MA userId in SecureStore → isAuthenticated=true (senza token)
  │   │   (l'autenticazione server avverrà al bootstrap via connectAll())
  │   └─ Nessun userId in SecureStore → /login
  │       ├─ Identità Signal non trovata → Genera nuova → Challenge-response
  │       └─ Identità trovata → Auth biometrica → Challenge-response
  └─ Non sbloccato biometricamente → /locked
      └─ Richiede sblocco biometrico
  ↓
Autenticato → /(tabs) → AppInitService bootstrap (10 step)
  ├─ 1. recoverStuckMessages (crash recovery)
  ├─ 2. Carica sessioni Signal dal DB
  ├─ 3. Init chat service (handler socket)
  ├─ 4. Carica rooms dal DB
  ├─ 5. Pre-key tracking
  ├─ 6. Carica profilo
  ├─ 7. Connette Socket.IO → onConnected() (sync)
  ├─ 8. Refresh pre-keys
  ├─ 9. Registra push token
  └─ 10. Setup lifecycle listeners
```

### Flusso onConnected (sync dopo connessione socket)

Eseguito ad ogni (ri)connessione socket. Ordine critico:

```
chatService.onConnected()
  ├─ 1. syncAllRoomsFromBackend()    → GET /chat, upsert rooms in DB
  ├─ 2. syncRoomMembersAndSessions() → sessioni con nuovi membri
  ├─ 3. queueService.forceProcess()  → invia messaggi in coda
  ├─ 4. fetchPendingSenderKeysForAllRooms() → scarica sender keys pendenti
  ├─ 5. refreshPreKeysIfNeeded()     → replenish pre-keys sotto soglia
  └─ 6. retrySendingMessages()       → re-encrypt e re-invia messaggi stuck
```

### Crittografia

- **Pair-wise** (Signal Protocol): usata per room con <4 membri. Ogni messaggio viene cifrato individualmente per ogni destinatario.
- **Sender Keys** (gruppo): usata per room con ≥4 membri. Un'unica cifratura, distribuzione chiavi ai membri. Rotazione ogni 1000 messaggi o 7 giorni.
- Le chiavi private non lasciano mai il dispositivo (keystore nativo).
- **Sender deviceId**: `processSenderKeyDistribution` e `decryptGroupMessage` accettano un `senderDeviceId?: number | null` opzionale. Lo store libsignal usa `(senderId, deviceId)` come chiave di lookup — se il payload del distribution o dell'envelope contiene `senderDeviceId` / `device_id_from`, viene forwardato al nativo (iOS `ProtocolAddress(name:, deviceId:)`, Android `SignalProtocolAddress(senderId, deviceId)`). Se assente, fallback a `1` (backward-compat single-device). Il fix mette il flusso sender key in parità col fix M-01 dei flussi pair-wise: necessario quando si abilita multi-device per evitare key collision nello store. Spec backend: `_shared/api/sender-key-device-id.md`.

### Session Establishment (Signal Protocol)

La session establishment segue il design asimmetrico di X3DH: solo chi entra nella room stabilisce proattivamente le sessioni. I membri esistenti ricevono la sessione automaticamente dal protocollo.

**Flusso quando B entra in una room dove c'è A:**

```
B (joiner)                              A (membro esistente)
──────────                              ────────────────────
1. API joinRoom()
2. Fetch pre-keys di A dal server
3. setRemoteUserKeys() + establishSession()
4. Salva sessione in DB
5. Invia SESSION_ESTABLISHED ad A
   (pacchetto cifrato, targeted)
                                        6. Riceve SESSION_ESTABLISHED
                                        7. decryptMessage() → libsignal auto-crea
                                           la sessione inversa (PreKeySignalMessage)
                                        8. ensureSessionInDatabase() salva in DB
                                        9. Handler aggiorna hasSession + sender keys
                                        10. A è pronto a inviare/ricevere
```

**Nota chiave:** A non ha bisogno di fetch delle pre-keys di B né di chiamare `establishSession()`. La sessione si crea automaticamente durante il decrypt del PreKeySignalMessage grazie al design asimmetrico di X3DH. Questo è il funzionamento nativo del Signal Protocol.

**3 livelli di copertura (fallback progressivo):**

| Livello | Trigger | Quando | Note |
|---|---|---|---|
| 1. `SESSION_ESTABLISHED` da joiner | Pacchetto targettizzato dal joiner | Online | Immediato, gestisce anche sender key redistribution |
| 2. `syncRoomMembersAndSessions()` | Ogni riconnessione socket | Dopo offline | Controlla tutti i membri di tutte le room |
| 3. `decryptMessage()` auto-establishment | Primo messaggio ricevuto (PreKeySignalMessage) | Sempre | Fallback ultimo — libsignal crea la sessione durante il decrypt |

**Auto-establishment nei moduli nativi:** `decryptMessage` su entrambe le piattaforme (iOS e Android) supporta il decrypt di PreKeySignalMessage anche senza una sessione pre-esistente. Se `encryptedSessions[remoteUserId]` non esiste, il modulo crea automaticamente un `EncryptedSession` con `remoteUser: nil` e lascia che libsignal gestisca l'auto-establishment via X3DH durante il decrypt. La sessione viene poi persistita in `encryptedSessions` per l'uso futuro. Questo è il comportamento corretto del Signal Protocol.

**Nessuna race condition** grazie al `messageQueue`: sia `SESSION_ESTABLISHED`, `user_joined` che i messaggi dell'utente passano per `processEnvelope`, serializzati nella stessa coda.

### Multi-device pairing (wire v2.1)

L'app supporta multi-device: un utente può collegare fino a 5 device attivi (1 primary + 4 linked) condividendo la stessa identity Signal. Wire protocol v2.1 — direzione **new device mostra QR, primary scansiona** (ADR-0003) con **safety number simmetrico pre-commit** (ADR-0004). La spec wire è in `_shared/api/multi-device-linking.md`.

**Cosa cambia rispetto alla v2:** lo smoke fisico del 2026-05-20 ha mostrato che nella v2 il telefono chiedeva di confrontare la SN prima che il desktop avesse `P_pub` per calcolare la propria — il SN era nominalmente confrontabile ma di fatto inverificabile (chicken-and-egg). La v2.1 inserisce un endpoint intermedio `POST /link/share-pubkey` (primary JWT) che pubblica `P_pub` lato session SENZA committare l'identity transfer, in modo che il new device possa calcolare e mostrare la SN PRIMA di /complete. Il SN torna a essere gate pre-commit invece di rollback-based.

**Sequenza:**

```
NEW DEVICE                                PRIMARY
─────────                                 ─────────
1. genera (E_pub, E_priv) X25519
2. POST /auth/devices/link/init (anon)
   { ephemeralPublicKey: E_pub, deviceName? }
   ← { sessionId, expiresAt }
3. mostra QR(tillit://link?v=2&i=<sessionId>&s=<server>&e=<E_pub>)
                                          4. scansiona QR (camera nativa)
                                          5. verifica serverOrigin == proprio
                                          6. genera (P_pub, P_priv)
                                          7. computa safetyNumber(E_pub, P_pub,
                                                                   identityPub,
                                                                   primaryUserId)
                                          8. POST /link/share-pubkey (JWT primary)
                                             { sessionId, primaryEphemeralPublicKey: P_pub }
                                             ← { ok: true }
                                             // session.status → pubkey-shared
                                          9. mostra SN sul telefono → tap Match
10. GET /link/session/:sessionId/result
    (polling 2s) → { status: 'pubkey-shared',
                     primaryEphemeralPublicKey: P_pub,
                     primaryUserId, identityKeyPub }
11. computa safetyNumber con gli stessi 4 input
    mostra SN sul new device → tap Match
                                          12. user tap Match → POST /link/complete
                                              { sessionId, encryptedPayload }   ← NO P_pub
                                              ← { assignedDeviceId }
                                              // session.status → completed
13. GET /result continua → riceve
    { status: 'completed', encryptedPayload, ... }
14. peekProvisioningPayload (decrypt + integrity check)
15. **anti-tamper check**: identityKeyPub dal payload
    MUST == identityKeyPub ricevuto in pubkey-shared
    mismatch → abort IDENTITY_KEY_TAMPERED
16. consumeProvisioningPayload (Keychain install)
17. challenge-response → primo JWT del new device
18. POST /keys/ → backend emette deviceLinked al primary
```

**Garanzie chiave (ADR-0003 + ADR-0004):**

- `E_pub` viaggia **in-band nel QR**, non via server → MITM via key-substitution lato server è impossibile (il primary legge E_pub direttamente dallo schermo del new device).
- `P_pub` viaggia via server (in /share-pubkey poi /result); il **safety number simmetrico** in pubkey-shared lo copre — se il server lo sostituisce, le due SN divergono e l'utente rifiuta prima di /complete.
- `identityKeyPub` viene servito dal server al new device in pubkey-shared (lookup del bundle pubblico del primary) E arriva di nuovo dentro l'encryptedPayload al completed: l'**anti-tamper check** lato client confronta i due e abort se differiscono.
- Safety number 60 cifre confrontate out-of-band su entrambi i device, **pre-commit** — il commit (POST /complete) avviene solo dopo che entrambi hanno tappato Match.
- Identity privata non lascia mai il Keychain nativo (path Option B: `encryptProvisioningPayload` legge dal Keychain, `consumeProvisioningPayload` scrive nel Keychain, JS vede solo ciphertext / bundle pubblico).
- One-time-use lato server: `GET /link/session/:id/result` con `status=completed` marca `consumed_at` e droppa `encryptedPayload` + `primaryEphemeralPub` dalla riga.

**Edge case di tempistica:** l'utente del new device può tappare Match prima che il primary chiami /complete (la SN è già visibile al pubkey-shared). In quel caso `confirmNewDeviceSafetyAndInstall` registra un waiter su `payloadArrivalResolvers` e si sblocca quando `onCompletedReady` riceve il payload dal poll. UI: durante l'attesa i bottoni Match/Mismatch lasciano il posto a un piccolo spinner ("In attesa di conferma dal dispositivo principale…").

**Componenti app:**

| File | Ruolo |
|---|---|
| `app/link-device.tsx` | **Primary side**: camera scanner, validazione serverOrigin, safety number, complete |
| `app/claim-device.tsx` | **New device side**: linkInit, QR + countdown, polling result, peek, safety number, install |
| `src/services/device.service.ts` | Orchestratore: `parseProvisioningLink` (parser v=2 strict), `handlePrimaryScannedQR` (include /share-pubkey), `confirmPrimarySafetyAndComplete` (body senza P_pub), `startNewDeviceLink`, `pollNewDeviceSessionResult` (branch su `pubkey-shared` / `completed`), `onPubkeyShared`, `onCompletedReady` (anti-tamper), `confirmNewDeviceSafetyAndInstall` (attende il payload via `payloadArrivalResolvers` se necessario), `loadDevices`, `revokeDevice` |
| `src/stores/device.store.ts` | Phase machines invariati: `pairingPrimary` (`idle → scanning → safetyCheck → completing → done\|error`) e `pairingNewDevice` (`idle → init → waiting → polling → safetyCheck → installing → done\|error`). Stato esteso: `identityKeyPubFromShare` (anti-tamper), `safetyConfirmed` (utente ha tappato Match anche se payload non ancora arrivato). |
| `src/types/device.ts` | Types wire v2.1 (`LinkSharePubkeyRequest/Response`, `LinkCompleteRequest` senza `primaryEphemeralPublicKey`, `LinkSessionResultResponse` con stato `pubkey-shared` + `primaryUserId` + `identityKeyPub`) |
| `app/+native-intent.ts` | Deep link `tillit://link?v=2&i=...` → parking in `app.store.pendingPrimaryScanLink` → redirect a `/link-device` (primary scanner) |

**Wire URL (QR):**

```
tillit://link?v=2&i=<sessionId>&s=<base64url(server_origin)>&e=<base64url(E_pub)>
```

Tutti i campi obbligatori. Mismatch `serverOrigin` lato primary → abort con `SERVER_MISMATCH`, nessuna chiamata `/complete`.

**Endpoints backend (v2):**

| Metodo | Path | Auth | Lato |
|---|---|---|---|
| POST | `/auth/devices/link/init` | anonimo | new device |
| POST | `/auth/devices/link/share-pubkey` | primary JWT | primary |
| POST | `/auth/devices/link/complete` | primary JWT | primary |
| GET | `/auth/devices/link/session/:sessionId/result` | anonimo (sessionId bearer) | new device |
| GET | `/auth/devices` | primary JWT | primary |
| DELETE | `/auth/devices/:id` | primary JWT | primary |
| DELETE | `/auth/devices/me` | qualsiasi | rollback |

Tutto in `api.service.ts`: `linkInit`, `linkSharePubkey`, `linkComplete`, `linkSessionResult`, `listDevices`, `revokeDevice`, `revokeMyDevice`.

**Server origin (Q2 dell'ADR-0003):** il new device usa `serverRegistry.getDefaultServer().apiUrl` (default `https://api.tillit.cc` o `EXPO_PUBLIC_API_URL`) come `serverOrigin` del QR. Il claim screen mostra l'origin attivo in chiaro. Per scenari multi-server (incluso `.onion`), il `ServerStatusModal` permette di sostituire il default prima di iniziare il pairing.

### Multi-device cache refresh — scoperta di nuovi device dei peer

`sessionService.deviceMap` (`userId → Set<deviceId>`) è la cache che alimenta il fan-out send in `chat.service.encrypt`: per ogni messaggio uscente si emette un ciphertext per ogni `(peerUserId, deviceId)` conosciuto. Senza un meccanismo di refresh, quando un peer linka un nuovo device dopo che abbiamo già stabilito la sessione, i suoi nuovi device non riescono mai a decifrare i nostri messaggi.

**Tre livelli di copertura (fallback progressivo):**

| Livello | Trigger | Latenza | File |
|---|---|---|---|
| 1. Refresh in `syncRoomMembersAndSessions` | Ogni `onConnected` socket | ~secondi al reconnect | `chat.service.ts` |
| 2. Persistenza `remoteKnownDevices` CSV in `session` | Cold start app | Hot al primo send dopo restart | `session.repository.ts`, `client.ts` (migration v4) |
| 3. Push socket `peerDeviceLinked` dal backend | Quando il peer completa un link | Near-realtime se entrambi online | `socket.service.ts`, `chat.service.ts` |

**Componenti chiave:**

- `sessionService.refreshRemoteDeviceMap(roomId, remoteUserId, { force? })` — fetch `/keys/:userId` + `updateRemoteDeviceMap`, niente native, niente sessione. Throttle per-userId 60s. Chiamato da `syncRoomMembersAndSessions` per ogni membro (con o senza sessione), dedupato per userId. **Anche per `ownUserId`** (force:true, una sola volta per sync per server): `GET /chat/:id/members` filtra fuori il requester, quindi senza un refresh esplicito self la `deviceMap[ownUserId]` resterebbe vuota e il self-fanout in `encrypt()` non emetterebbe entry per i nostri linked device. Stesso refresh self gira eager nell'handler `onDeviceLinked` (invalidate + force refresh) così il primo send dopo il linking include subito il nuovo device.
- `sessionService.invalidateRemoteDeviceMap(userId)` — droppa la cache + svuota il CSV persistito. Chiamato dal handler `peerDeviceLinked` per invalidare e re-fetch eager.
- `updateRemoteDeviceMap()` persiste la lista come CSV `1,2,5` nel campo `session.remote_known_devices` (denormalizzato — replicato su ogni riga session per quell'utente, valore <200 char).
- `loadSessions()` reidrata `deviceMap` dal CSV al boot — il primo send dopo restart non cade più su `[PRIMARY_DEVICE_ID]`.
- `setSession()` con sessione esistente fa **anche** `refreshRemoteDeviceMap()` (detached) — niente più early-return cieca al device map outdated.
- `sessionService.ensureSessionForRemotePeerDevice(roomId, remoteUserId, deviceId)` — analogo a `ensureSessionForOwnLinkedDevice` ma per i peer. Lazy session establishment per-(userId, deviceId): la deviceMap può includere device linkati DOPO il `setSession` originale, e libsignal non avrebbe la sessione per `(peer, newDeviceId)`. Lookup `findByUserRoomAndDevice` → resume se esiste, altrimenti `/keys/:userId` + pick bundle per `deviceId` + `setRemoteUserKeys` + `establishSession` + upsert riga per-device. Chiamato dal fan-out di `chat.service.encrypt` per ogni `deviceId !== PRIMARY_DEVICE_ID`. Errori su device non-primary swallowati con warn (non droppano il messaggio per il primary del peer).
- **Receive path multi-device**: `chat.service.decrypt(body, roomId, fromUserId, fromDeviceId?)` forwarda il `senderDeviceId` al native `SignalProtocol.decryptMessage(body, remoteUserId, deviceId)`. Senza questo, il native faceva default a `deviceId=1` e un messaggio da un linked device del peer veniva decifrato contro la sessione del primary → protobuf decode error. Entrambi i call site (`handleUserMessage` e `handleControlPacket`) passano `envelope.device_id_from`. `sessionService.ensureSessionInDatabase` accetta anche `deviceId` e usa `findByUserRoomAndDevice` per la check di esistenza, così la riga session viene persistita per il device specifico e `loadSessions` resume tutte le sessioni multi-device al boot.
- **Self-fan-out visibility**: il filtro "skip own messages" in `handleIncomingMessage` e in `decrypt` scarta una entry SOLO quando `device_id_from` è **esplicitamente presente** (`typeof === 'number'`) E coincide con `ownDeviceId` (true echo del proprio device). Se l'envelope non porta `device_id_from`, NON si classifica come echo: il dedup downstream (`processingMessages` per `category:id` + `messageRepository.findById` in `handleUserMessage`) cattura comunque i veri echos. Questo è necessario perché il backend (o specifici code path come il self-fanout) può consegnare un envelope senza `senderDeviceId`: il fallback al `PRIMARY_DEVICE_ID` farebbe coincidere `senderDeviceId === ownDeviceId === 1` sul primary e droppasse il self-fanout dei linked device. Il mobile non setta `device_id_from` nelle `MessageEnvelopeFactory.create*` outgoing — solo il desktop lo fa — quindi la resilienza in ricezione è necessaria. `handleUserMessage` riconosce `isSelfFanout` e setta `idStatus = MessageStatus.SENT` (render lato proprio della bubble), salta unread counter/haptic/banner, e non emette `MESSAGE_DELIVERED`/`MESSAGE_READ` ack (non ha senso ack a se stesso).

**Spec & coordination:** evento `peerDeviceLinked` in `_shared/api/peer-device-linked.md`; task in `_shared/tasks/frontend-0008-multi-device-cache-refresh.md` (frontend) e `backend-0009-peer-device-linked-notify.md` (backend, done 2026-05-21).

### Multi-device send — wire shape `sendMessage`

Il fan-out per-device cifra un ciphertext per ogni `(userId, deviceId)` e li manda nello stesso emit `sendMessage`. Il gateway backend instrada al path multi-device (`fanOutToRecipients`) **solo** se `recipients[]` è **top-level** nel payload del socket — se annidato dentro `message.payload` cade sul path legacy `sendToRoom` che fa broadcast singolo e filtra per `userId`, scartando *tutti* i device del mittente (il mittente non vede mai il proprio messaggio sui suoi altri device).

**Due wire shape, scelte da `socket.sendMessage` (due overload):**

| Shape | Payload emesso | Quando |
|---|---|---|
| Fan-out | `{ roomId, recipients[], metadata?, category, type, volatile? }` | Path pair-wise / encrypted (`encryptedData.recipients` popolato) |
| Legacy | `{ roomId, message, category, type, volatile? }` | Path sender-key (un solo ciphertext per la room) |

- `RecipientFanout = { userId: number, deviceId: number, ciphertext: string }`. `userId` **deve essere numerico** sul wire — il backend `FanoutRecipientDto` usa `@IsNumber()` senza `enableImplicitConversion`, quindi una stringa viene rifiutata dal `ValidationPipe`, il gateway non invoca l'handler, e il client va in timeout 30s. `recipients[]`, `metadata`, `volatile` viaggiano **top-level**, mai dentro `message`.
- `SendMessageMetadata = { id_parent?, version? }` — metadata envelope-level che devono sopravvivere al fan-out (l'envelope per-device è ricostruito dal backend). `metadata` è omesso se vuoto.
- `chat.service.emitSendMessage(socket, roomId, serverBody, category, type)` è l'unico punto che instrada: ispeziona `serverBody.payload.recipients` → fan-out vs legacy. Tutti i call site di send (`sendEnvelope`, `sendPersistentImage`, `sendEphemeralImage`, `sendFileMessage`, `retryMessageSend`, e il drain della retry queue in `queueService.setSendFunction`) passano da qui.
- La retry queue continua a salvare `serverBody` con `payload.recipients` annidato (local state invariato); `emitSendMessage` traduce nel wire shape giusto al drain.
- **Nota:** `sendControlPacket` → `socket.sendPacket` annida ancora `recipients` in `envelope.payload` (vecchio shape). Migrazione control packet a `recipients[]` top-level non ancora fatta — vedi `_shared/questions.md`.

**Spec & coordination:** `_shared/specs/multidevice-send-wire-shape.md`, `_shared/api/multi-device-fanout.md`; task `frontend-0010` (done), `backend-0010`, `desktop-0012`.

### Categorie di messaggi

- `user` — messaggi utente (testo, immagini, audio, video, file, posizione)
- `senderkey_message` — messaggi cifrati con sender keys
- `control` — pacchetti di controllo cifrati (receipts, typing, profilo aggiornato, `SESSION_ESTABLISHED`). Il decrypt di `SESSION_ESTABLISHED` auto-stabilisce la sessione inversa via PreKeySignalMessage.
- `system` — messaggi di sistema (user_joined, user_left, room_deleted, room_renamed, message_deleted)
- `action` — azioni

**Eventi socket top-level** (non passano per la message queue, gestiti direttamente):
- `roomDeleted` — la room è stata eliminata (da admin o dal server). Cleanup locale completo.
- `userLeftRoom` — un utente è uscito dalla room. Se è l'utente corrente, cleanup completo; altrimenti rimozione messaggi e profilo.

### Anteprime messaggi — `UserMessageType`

Per i tipi non testuali, il `body` del messaggio è un JSON serializzato (mediaId+key per immagini/file, lat/lng per location, ecc.). Questo JSON **non deve mai essere mostrato all'utente**.

**Helper unico:** `src/utils/message-preview.ts → getMessagePreview(body, type, options?)` — switch esaustivo su `UserMessageType`. È la **single source of truth** per ogni anteprima one-line.

**Punti che usano l'helper (e che vanno aggiornati per ogni nuovo tipo):**

| Punto | File | Cosa rende |
|---|---|---|
| Render del bubble | `src/components/chat/MessageBubble.tsx` (`renderContent`) | Contenuto vero e proprio del messaggio |
| Reply preview nel bubble | `src/components/chat/MessageBubble.tsx` (`ReplyPreview`) | Riga sotto "In risposta a" |
| Reply bar sopra l'input | `src/components/chat/MessageBar.tsx` | Riga sotto "Risposta" |
| Lista chat (ultimo msg) | `src/components/chat/RoomListItem.tsx` | Sottotitolo della stanza |
| Notifiche / banner | `src/services/chat.service.ts` (`messagePreview`) | Push e banner in-app |

**Stato store:** `RoomWithMetadata` porta `lastMessageText` **e** `lastMessageType`. Entrambi sono popolati da `chat.service.ts` ad ogni messaggio inviato/ricevuto e in `loadRooms` / `refreshRoomLastMessage`. Il helper preferisce sempre il `type` rispetto al `body`.

**Quando si aggiunge un nuovo `UserMessageType`** (es. `STICKER`, `CONTACT`):
1. Aggiungere il `case` in `getMessagePreview` con la chiave i18n appropriata. Se manca, TypeScript non segnala (lo switch ha un fallback su `inferFromBody`), quindi va verificato manualmente.
2. Aggiungere il `case` in `MessageBubble.renderContent` per il render reale.
3. Aggiungere il body extraction in `chat.service.ts → extractUserBody`.
4. Aggiungere chiavi i18n in `src/i18n/it.ts` e `src/i18n/en.ts` (sezione `chat.*`).
5. Verificare manualmente: invio + lista chat + reply bar + reply preview nel bubble + push.

### Immagini Effimere (Ephemeral Images)

Immagini con timer di autodistruzione (5s/10s/30s) protette da screenshot tramite modulo nativo `secure-view`.

**Flusso invio:**
```
Sender: AES-encrypt → upload blob (POST /media/ephemeral, TTL 24h)
        → Signal-encrypt metadata {mediaId, key, iv, viewDuration}
        → send via socket
```

**Flusso ricezione:**
```
Receiver: riceve metadata → mostra thumbnail blur + "Tocca per vedere"
  → tap → download blob (one-time) → decrypt in MEMORIA (no disk)
  → mostra in SecureView nativo (screenshot = nero su iOS)
  → countdown timer → scade → zero buffer, update body a {expired:true}
  → POST /media/:id/viewed → server elimina blob
```

**Garanzie di sicurezza:**
- Mai su disco decifrato (solo base64 in RAM)
- One-time download (server traccia)
- Server TTL 24h
- Screenshot nero iOS (SecureView con isSecureTextEntry trick)
- Screenshot nero Android (FLAG_SECURE globale)
- Chiave AES separata dal blob (viaggia nel messaggio E2E)
- Il mittente non può riaprire la propria immagine

**Tipo messaggio:** `EPHEMERAL_IMAGE` (`ephemeral_image`)

**File coinvolti:**
- `modules/secure-view/` — Modulo nativo Expo per protezione screenshot
- `src/types/message.ts` — `EphemeralImagePayload`, `createEphemeralImageMessage()`
- `src/services/chat.service.ts` — `sendEphemeralImageMessage()`
- `src/components/chat/MessageBubble.tsx` — `EphemeralImageContent`
- `src/components/modals/EphemeralImageViewerModal.tsx` — Viewer con timer + SecureView
- `src/components/modals/ImagePreviewModal.tsx` — Selettore modalità 3 opzioni + durata

### Schema database (SQLite + SQLCipher)

8 tabelle: `message`, `room`, `profile`, `session`, `identity`, `attachment`, `sender_key_session`, `sender_key_retry_queue`

Il database è cifrato con **SQLCipher** (AES-256). La chiave di cifratura è generata al primo avvio e salvata nello storage hardware-protected del modulo Signal Protocol (alias `tillit_protected/db_encryption_key`, gestito da `KeychainHelper`/`KeystoreHelper`). L'inizializzazione è asincrona: `initDatabase()` deve essere chiamato **dopo l'unlock biometrico** (lo step 0a del bootstrap in `app-init.service.ts` parte solo quando `isBiometricAuthenticated=true`). Il plugin `expo-sqlite` con `useSQLCipher: true` è configurato in `app.json`.

Migration legacy → protected: se la chiave esiste in `expo-secure-store` (vecchia posizione), `getOrCreateDatabaseKey()` la sposta nel protected storage al primo `initDatabase()` post-upgrade e la cancella dal SecureStore.

I flussi di "wipe identity" (`wipeAndCreate` / `deleteLocalIdentity` in `app/(auth)/login.tsx`) usano `wipeDatabaseFiles()` da `src/db/client.ts` per cancellare il file SQLite invece di aprirlo e svuotare le tabelle — la chiave di cifratura vive dietro il biometric ACL e non è accessibile prima dell'authenticate.

Se il DB esistente non è cifrato (upgrade da versione precedente), viene eliminato e ricreato — le room si risincroneranno dal server.

### Migrazioni database

**File:** `src/db/client.ts`

Il database usa un sistema di migrazioni a due livelli basato su `PRAGMA user_version` di SQLite:

1. **`createTables()`** — contiene il DDL completo con `CREATE TABLE IF NOT EXISTS`. Riflette sempre lo schema più recente. Per nuove installazioni crea tutto. Per installazioni esistenti è un no-op (le tabelle esistono già).

2. **`applyMigrations()`** — applica modifiche incrementali (`ALTER TABLE`, ecc.) ai database esistenti. Usa `PRAGMA user_version` per tracciare la versione corrente. Ogni statement è wrappato in try/catch per gestire il caso in cui la colonna esista già (fresh install).

```typescript
// src/db/client.ts — array MIGRATIONS (snippet, vedi file per la lista completa)
const MIGRATIONS: { version: number; statements: string[] }[] = [
  { version: 1, statements: ['ALTER TABLE room ADD COLUMN administered ...'] },
  { version: 2, statements: ['ALTER TABLE server ADD COLUMN is_tor ...'] },
  { version: 3, statements: ['DROP INDEX ...', 'CREATE UNIQUE INDEX ... session(id_user, id_room, remote_user_device_id)'] },
  { version: 4, statements: ['ALTER TABLE session ADD COLUMN remote_known_devices TEXT'] },
];
```

**Per aggiungere una nuova migrazione:**

1. Aggiungere la colonna/tabella nel `CREATE TABLE` dentro `createTables()` (per nuove installazioni)
2. Aggiungere un nuovo entry nell'array `MIGRATIONS` con `version: N+1` e i relativi `ALTER TABLE`
3. Aggiornare lo schema Drizzle in `src/db/schema.ts`

**Flusso all'avvio:**
```
getDatabase()
  ├─ openDatabaseSync()
  ├─ createTables()       → CREATE TABLE IF NOT EXISTS (no-op su DB esistenti)
  └─ applyMigrations()    → PRAGMA user_version check → ALTER TABLE incrementali
```

| Scenario | createTables | applyMigrations |
|---|---|---|
| Nuova installazione | Crea tutto | ALTER fallisce silenziosamente (colonna esiste), user_version = latest |
| Update da prod | IF NOT EXISTS → no-op | Applica ALTER mancanti, user_version aggiornata |
| Già aggiornato | no-op | user_version ≥ latest → skip |

**NON usare Drizzle migrations** (`drizzle-kit generate`/`migrate()`). Non sono compatibili con database creati da `createTables()` perché la migrazione iniziale generata è un `CREATE TABLE` senza `IF NOT EXISTS` che fallirebbe su DB esistenti.

### Stanze amministrate

Le room possono essere "amministrate" (`administered: 1` nel DB). Il comportamento cambia in base al ruolo:

- **Admin (creatore):** può eliminare la stanza (`DELETE /chat/:id` → `action: 'deleted'`, cancella per tutti)
- **Non-admin in stanza amministrata:** può solo uscire (`DELETE /chat/:id` → `action: 'left'`, esce solo lui)
- **Stanza non amministrata:** tutti possono eliminare (comportamento legacy)

**Eventi socket top-level:**

| Evento | Payload | Azione frontend |
|---|---|---|
| `roomDeleted` | `{ roomId, deletedBy, timestamp }` | `performLocalRoomCleanup()` — rimuove room, messaggi, sessioni, immagini |
| `userLeftRoom` | `{ roomId, userId, timestamp }` | Se `userId === self` → cleanup completo. Altrimenti → rimuove messaggi e profilo dell'utente uscito |

**UI condizionale:** Lo swipe-to-delete nella lista room e il pulsante in `RoomDetailsModal` mostrano "Elimina stanza" o "Esci dalla stanza" in base a `room.administered` e `room.idUser === currentUserId`.

**Toggle creazione:** `InvitationModal` ha un `Switch` "Stanza amministrata" che passa `administered: true` a `PUT /chat`.

**File coinvolti:** `src/db/schema.ts`, `src/services/socket.service.ts`, `src/services/chat.service.ts`, `src/services/api.service.ts`, `src/components/modals/InvitationModal.tsx`, `src/components/modals/RoomDetailsModal.tsx`, `app/(tabs)/index.tsx`, `app/chat/[id].tsx`.

### DSA Reporting & Server Health Check

Conformità al Digital Services Act: segnalazione contenuti/utenti e gestione ban.

**Report (messaggio o utente):**
- Singolo endpoint `POST /moderation/report` con `messageId` opzionale (null = report utente)
- Motivi: `spam`, `harassment`, `illegal_content`, `other` + descrizione opzionale
- Report messaggio: long press su messaggio altrui → "Segnala" nel context menu → selezione motivo
- Report utente: dettagli room → long press su membro → selezione motivo

**Health check server:**
- `GET /auth/status` → `ok` / `banned` / `unauthorized` / offline (network error)
- `healthCheckService.checkServer(serverId)` — verifica singolo server, aggiorna `bannedServers`, disconnette socket se bannato
- `healthCheckService.checkAll()` — itera tutti i server chiamando `checkServer()` per ciascuno
- Trigger: bootstrap (dopo connessione socket), resume app (AppState `active`), e `connect_error` del socket (rilevamento immediato ban)

**Rilevamento immediato ban su `connect_error`:**
- Se il socket riceve un `connect_error` con errore auth, chiama `healthCheckService.checkServer()` prima di triggerare il logout
- Se il server risulta bannato, il logout viene soppresso (il ban è gestito separatamente)
- Import lazy (`require()`) in `socket.service.ts` per evitare dipendenza circolare

**Resilienza ban — App accessibile anche con server bannato:**
- L'autenticazione nell'app è basata sull'identità locale (`userId` in SecureStore), non sul token server. Se il token default è scaduto ma `userId` esiste, `loadStoredToken()` setta `isAuthenticated=true` senza token — l'auth server avviene al bootstrap via `connectAll()`.
- `connectAll()`: se `authenticateServer()` ritorna 401 BANNED, chiama `setBanned(serverId, true)` e salta la connessione socket (niente logout).
- `onAuthError` del default server: se `isBanned(serverId)` è true, salta il logout.
- `ensureSocketsConnected()`: salta i server bannati durante il resume da background.

**Server bannato:**
- `bannedServers: Set<number>` nel `server.store.ts`
- Socket non si connette se `isBanned(serverId)` è true
- `ServerStatusModal`: badge rosso "Inaccessibile", messaggio "Account sospeso", pulsante riconnessione nascosto
- `app/chat/[id].tsx`: `useEffect` osserva `bannedServers` — se il server della room corrente viene bannato, mostra Alert ed espelle l'utente dalla chat

**File coinvolti:** `src/services/api.service.ts`, `src/services/health-check.service.ts`, `src/services/app-init.service.ts`, `src/services/socket.service.ts`, `src/stores/server.store.ts`, `src/components/chat/MessageContextMenu.tsx`, `src/components/modals/RoomDetailsModal.tsx`, `src/components/modals/ServerStatusModal.tsx`, `app/chat/[id].tsx`.

### Account deletion ("Elimina identità e dati")

Conformità ad Apple Guideline 5.1.1(v) e GDPR Art. 17. L'utente può eliminare definitivamente la propria identità, sia lato device che sui server, dal Profile screen.

**Flusso (`appInitService.deleteAccount()`):**

```
User tap "Elimina identità e dati" in Profile
  → Alert conferma (testo destruttivo)
  ↓ on confirm:
  1. Per OGNI server registrato → DELETE /auth/account (best-effort, errori raccolti)
  2. chatService.destroy() + serverRegistry.clearAll()
  3. SignalProtocol.clearIdentity() (Keychain / Keystore nativo)
  4. SecureStore: cancella tutti i token + signal_user_id
  5. clearAllIdentityData() → cancella tutte le tabelle SQLite + image files
  6. Reset Zustand stores (chat, auth)
  7. Teardown listeners + reset initialized flag
  → router.replace('/(auth)/login') (fresh identity creation)
```

Se uno o più server NON confermano la cancellazione (network error, 5xx), la procedura continua comunque: i dati locali vengono cancellati e l'utente vede un avviso non bloccante ("Eliminazione parziale"). I record residui server-side diventano irraggiungibili perché la chiave privata viene distrutta.

**API:** `DELETE /auth/account` con JWT. Contratto in `_shared/api/auth-account-delete.md`.

**Privacy Policy:** link in Login (footer) e Profile (sezione "Privacy e dati") → `https://tillit.cc/privacy-policy.html` (apre nel browser di sistema via `Linking.openURL`).

**File coinvolti:** `src/services/app-init.service.ts` (`deleteAccount()`), `src/services/api.service.ts` (`deleteAccount()`), `app/(tabs)/profile.tsx`, `app/(auth)/login.tsx`, `src/i18n/it.ts`, `src/i18n/en.ts`.

### Deep link — Invito a stanza

L'app gestisce universal link nel formato `https://tillit.cc/roomcode/{CODE}` per entrare in una stanza tramite codice invito.

**Flusso:**

```
Universal link → +native-intent.ts
  ├─ Estrae il codice dalla URL (/roomcode/ABC123)
  ├─ Setta pendingInviteCode nello Zustand store (app.store.ts)
  └─ Ritorna '/join-room' a Expo Router
        ↓
_layout.tsx (redirect effect)
  ├─ Se utente non autenticato → /login → dopo auth → /join-room
  └─ Se autenticato → /join-room
        ↓
join-room.tsx
  ├─ Bootstrap app (appInitService.initialize(), idempotent)
  ├─ Se username già salvato → auto-join immediato
  ├─ Se username mancante → mostra form con input nome
  ├─ Join → chatService.joinRoom(code, name) → redirect a /chat/{roomId}
  └─ Cancel → setPendingInviteCode(null) → redirect a /(tabs)
```

**File coinvolti:** `app/+native-intent.ts`, `app/join-room.tsx`, `app/_layout.tsx`, `src/stores/app.store.ts` (`pendingInviteCode`).

**Nota dev:** Premendo `r` in Expo dev il deep link iniziale viene rielaborato da `+native-intent.ts` perché l'URL di lancio persiste nel layer nativo. È un comportamento solo dev, in produzione non si verifica.

### Share Target — Condivisione immagini

L'app supporta la ricezione di immagini condivise da app esterne (es. Galleria, Safari) tramite iOS Share Extension e Android Share Intent.

**Flusso:**

```
Share Extension (iOS) / Share Intent (Android)
  → Deep link con dataUrl=tillitnativeShareKey
  → +native-intent.ts ritorna '/share-target'
  → _layout.tsx redirige se necessario (dopo auth)
        ↓
share-target.tsx
  ├─ ShareIntentProvider (in _layout.tsx) cattura i dati condivisi
  ├─ Bootstrap app (appInitService.initialize(), idempotent)
  ├─ Mostra anteprima immagine + lista room ordinate per attività recente
  ├─ Tap su room → convertFileToImagePayload() → chatService.sendImageMessage()
  └─ Annulla → resetShareIntent() → /(tabs)
```

**File coinvolti:** `app/share-target.tsx`, `app/+native-intent.ts`, `app/_layout.tsx`, `src/utils/image.ts` (`convertFileToImagePayload`).

**Dipendenze:** `expo-share-intent` (provider wrappa il root layout, deve montarsi prima dell'auth per catturare l'URL iniziale).

### Tor Hidden Service Support (.onion)

L'app supporta server raggiungibili via Tor hidden service (`.onion`) per garantire anonimato completo. L'architettura multi-server isola ogni server con la propria coppia `ApiService`/`SocketService`, quindi Tor è un flag per-server.

**Problema RN**: React Native non supporta SOCKS5 proxy — sia Axios (usa `XMLHttpRequest` bridgato) che Socket.IO (usa WebSocket nativo) passano per lo stack di rete nativo. Il modulo nativo `tor-proxy` risolve avviando un daemon Tor embedded ed esponendo metodi nativi per HTTP e WebSocket via SOCKS proxy locale.

**Librerie native:**
- **iOS**: `Tor.framework` v408 (progetto iCepa, CocoaPods). Include `TorThread`, `TorController`, `TorConfiguration`.
- **Android**: `tor-android` v0.4.8.19 (Guardian Project, Maven) + `jtorctl` v0.4.5.7. Usa `OkHttpClient` con `Proxy.Type.SOCKS`.

**Architettura:**

```
Server .onion configurato
  → ServerRegistry rileva .onion nell'URL (o isTor=1 in DB)
  → torService.ensureStarted() → daemon Tor embedded → SOCKS5 su 127.0.0.1:<porta>
  → ApiService(useTor=true) → Axios adapter custom → TorProxy.httpRequest() nativo
  → SocketService(useTor=true) → Socket.IO con TorWebSocket → TorProxy.openWebSocket() nativo
```

**Transport layer:**
- `src/services/tor-axios-adapter.ts` — Axios adapter che per URL `.onion` delega a `TorProxy.httpRequest()`, altrimenti usa il default
- `src/services/tor-websocket.ts` — Classe WebSocket-compatible che usa `TorProxy.openWebSocket()`. Iniettata in Socket.IO via `opts.webSocket`
- `src/services/tor.service.ts` — Singleton che gestisce il ciclo di vita del daemon Tor

**Lifecycle:**
- Tor parte SOLO se almeno un server `.onion` esiste
- Arti resta attivo per tutta la vita dell'app (non supporta stop/restart pulito)
- `torService.ensureStarted()` è idempotente — se già running ritorna la porta esistente

**Schema DB:** colonna `is_tor INTEGER NOT NULL DEFAULT 0` nella tabella `server` (migrazione v2)

**Sicurezza:**
- DNS leak: `.onion` risolto dentro Tor, mai dal DNS di sistema
- Push token: **NON registrato** per server `.onion` (passerebbe da Apple/Google, leak IP)
- Fallback clearnet: server `.onion` NON fallback mai su clearnet
- Code path completamente separati (adapter diversi per clearnet e Tor)

**File coinvolti:**
- `modules/tor-proxy/` — Modulo nativo Expo (iOS Swift + Android Kotlin)
- `src/services/tor.service.ts` — Lifecycle daemon
- `src/services/tor-axios-adapter.ts` — Custom Axios adapter
- `src/services/tor-websocket.ts` — Custom WebSocket per Socket.IO
- `src/services/api.service.ts` — Costruttore accetta `useTor`
- `src/services/socket.service.ts` — Costruttore accetta `useTor`
- `src/services/server-registry.ts` — Rileva `.onion`, passa `useTor`, gestisce lifecycle
- `src/services/app-init.service.ts` — Tor stop/start su background/foreground, skip push per Tor
- `src/db/schema.ts` + `src/db/client.ts` — Colonna `is_tor` + migrazione v2
- `src/components/modals/ServerStatusModal.tsx` — Badge Tor, notice .onion, validazione URL
- `src/components/ui/ConnectionStatusIcon.tsx` — Badge onion overlay
- `android/app/src/main/res/xml/network_security_config.xml` — Cleartext su localhost per SOCKS proxy

### Swipe-to-Reply

I messaggi nella chat supportano swipe orizzontale (da sinistra verso destra) per attivare la reply, stile WhatsApp/Telegram.

**Componente:** `src/components/chat/SwipeableMessage.tsx` — wrapper che avvolge ogni `MessageBubble` nella lista.

**Implementazione:**
- `Gesture.Pan()` da react-native-gesture-handler v2 (API moderna)
- Animazioni con `useSharedValue` + `useAnimatedStyle` di react-native-reanimated (tutto su UI thread)
- Soglia attivazione: 80px, traslazione massima: 100px
- Icona reply (`arrow-undo`) appare con opacity e scala proporzionali allo swipe
- Haptic feedback (`expo-haptics`, Medium impact) al superamento della soglia
- Snap-back con `withTiming` (150ms, senza rimbalzo)
- `activeOffsetX: [0, 20]` e `failOffsetY: [-10, 10]` per non interferire con lo scroll verticale della FlatList
- `failOffsetX: -1` per ignorare swipe verso sinistra

**Catena dei componenti:**
```
ChatList (renderItem)
  └─ SwipeableMessage (onReply → onSwipeReply prop)
       └─ MessageBubble
```

**Reply preview (MessageBar):** Usa `Reanimated.View` con `FadeIn`/`FadeOut` (entering/exiting layout animation) per mostrare/nascondere il banner di risposta. Gira interamente su UI thread.

**Requisito root:** `GestureHandlerRootView` wrappa il tree in `app/_layout.tsx` (dentro `RootNavigator`), necessario per il funzionamento di `GestureDetector`.

## Convenzioni di codice

### Logger

Usare sempre il logger diagnostico invece di `console.log`:

```typescript
import { logger } from '@/utils/logger';

logger.info('[NomeServizio] messaggio');
logger.warn('[NomeServizio] attenzione');
logger.error('[NomeServizio] errore');
```

Il logger scrive su console E nello Zustand store (`app.store.ts: connectionLog[]`, max 200 entry). I log sono visibili nella ServerStatusModal (10-tap sull'icona di connessione).

### Servizi singleton

Tutti i servizi sono esportati come singleton:

```typescript
class MyService { /* ... */ }
export const myService = new MyService();
```

Servizi principali: `apiService`, `chatService`, `socketService`, `sessionService`, `senderKeyService`, `queueService`, `appInitService`, `healthCheckService`.

### Repository pattern

Accesso DB sempre tramite repository (`src/db/repositories/`):
- `messageRepository`, `roomRepository`, `profileRepository`, `sessionRepository`, `senderKeyRepository`

### State management

- **Zustand + Immer** per stato reattivo
- 3 store: `useAuthStore`, `useAppStore`, `useChatStore`
- Accesso fuori dai componenti: `useStore.getState().action()`

### Serial message queue

`chatService.messageQueue` serializza **tutte** le operazioni di encrypt/decrypt del Signal Protocol. Il modulo nativo NON è thread-safe — operazioni concorrenti corrompono il ratchet state. Non rimuovere mai la serializzazione **delle operazioni Signal Protocol**.

**Quello che NON sta sulla coda — di proposito:** il `socket.sendPacket` dei control packet (network emit + ack-await del backend) gira **detached**, fuori dalla catena del `messageQueue`. Un ack del backend lento (lo zombie di `backend-0015` = 5 s) non blocca più i `sendMessage` accodati dopo. In `sendControlPacket` solo `encryptStep` (l'encrypt vero) è sulla coda; `networkStep` parte fire-and-forget. Vedi `_shared/tasks/frontend-0015-…md`. `sendEnvelope` (messaggi utente) continua invece a tenere il network sulla coda — è un sotto-caso meno frequente e attende `backend-0015` per il vero fix lato server.

### Receipt coalescing & dedup

- `markRoomAsRead` raggruppa gli id non letti per `idUserFrom` ed emette **un** `MESSAGE_READ` per sender con shape `{ id_message: last, id_messages: [...] }`. Per N=1 mantiene lo shape legacy `{ id_message }`. Contratto wire (decifrato, E2E — backend opaco): `_shared/api/control-packet-read-coalesced.md`.
- `processControlPacket` MESSAGE_READ legge `id_messages[]` se presente, fallback a `id_message`. Un peer che invia solo `id_message` continua a funzionare.
- `handleUserMessage` / `handleSenderKeyMessage` inviano **un solo** packet per messaggio ricevuto: READ se la room è aperta, altrimenti DELIVERED. READ implica DELIVERED — niente più doppio invio.
- `sendTypingStopped` NON azzera il throttle di `typing_start`: il primo keystroke dopo lo stop non ri-arma un `typing_start` finché la finestra `TYPING_THROTTLE_MS` non scade. Lo stato attivo è tracciato da `typingActiveRooms: Set<number>` per emettere un solo `typing_stop` per burst.

### Multi-device read sync (self-fanout MESSAGE_READ)

Quando un altro device dello stesso utente legge una conversazione, spedisce un packet `MESSAGE_READ` con `recipients[]` top-level che include anche le entry self-fanout. Il packet arriva su questo device tramite `processControlPacket → case MESSAGE_READ`. Il ramo è ora **orientato self-vs-peer** (`isSelfFanout = fromUserId === selfUserId || fromUserId === serverUserId`):

- **Self-fanout + target incoming** (`idUserFrom !== selfUserId && != serverUserId`): stampa il timestamp `read` sulla row incoming via `messageRepository.markAsRead(id)` (idempotente: `WHERE read IS NULL`) + `updateMessage({ read, idStatus: READ })`. A fine ciclo, se almeno una row è stata applicata: `recomputeRoomUnread(roomId)` (query DB `countUnreadIncoming(roomId, [selfUserId, serverUserId])`) → `updateRoomInList({ unreadCount })` + `refreshOsBadge()` (somma `allRooms[].unreadCount` → `Notifications.setBadgeCountAsync`).
- **Peer-read path invariato** (altrimenti): blind idStatus advance se `< READ`. Anche envelope malformati (claim self-fanout ma target outgoing) cadono qui — robusto.
- **Nessun haptic/banner/"new message"** sul ramo self-sync — stessa filosofia di `handleUserMessage` con `isSelfFanout`.
- **MESSAGE_DELIVERED**: early-return su `isSelfFanout` (DELIVERED da sé verso sé non ha semantica).

`markRoomAsRead` (apertura chat locale) chiama anch'esso `refreshOsBadge` dopo l'azzeramento, chiudendo il mini-gap UX del badge OS che restava fino al foreground successivo. Spec: `_shared/api/multi-device-read-sync.md`, ADR `_shared/decisions/0006-multi-device-read-sync.md`.

### resumeSession memoization (modulo nativo)

`SignalProtocol.resumeSession` (iOS + Android) controlla la cache `(userId, deviceId)` PRIMA di ricostruire un `EncryptedSession`: se la entry è calda, ritorna `"Session already warm"` senza riaprire gli store cifrati (`EncryptedSharedPreferences` / Keychain) e senza sovrascrivere l'istanza che già porta lo stato del Double Ratchet. Il path di ricostruzione esplicita (recovery dopo decrypt error, rotazione chiavi) passa per `setRemoteUserKeys` ed è intatto — `resumeSession` non è più l'unico modo di scaldare la cache. Vedi `_shared/tasks/frontend-0016-…md`.

## Costanti chiave

| Costante | Valore | File | Descrizione |
|---|---|---|---|
| `SENDER_KEY_THRESHOLD` | 4 | `config/app.config.ts` | Membri minimi per sender keys |
| `SENDER_KEY_MESSAGE_ROTATION_THRESHOLD` | 1000 | `config/app.config.ts` | Messaggi prima della rotazione |
| `SENDER_KEY_ROTATION_THRESHOLD_SECONDS` | 7 giorni (in secondi) | `config/app.config.ts` | Secondi prima della rotazione sender key |
| `PREKEY_THRESHOLD` | 10 | `session.service.ts` | Soglia per replenish pre-keys |
| `PREKEY_BATCH_SIZE` | 50 | `session.service.ts` | Pre-keys generate per batch |
| `SIGNED_PREKEY_ROTATE_DAYS` | 30 | `session.service.ts` | Giorni per rotazione signed pre-key |
| `LOCK_TIMEOUT` | 30s | `app-init.service.ts` | Background prima di richiedere biometria |
| `MAX_RETRY_AGE_MS` | 2 ore | `chat.service.ts` | Messaggi stuck più vecchi → FAILED |
| `MAX_MESSAGES` | 200 | `chat.store.ts` | Messaggi in memoria per room |
| `connectionLog` limit | 200 | `app.store.ts` | Entry log diagnostici massime |
| `EPHEMERAL_DURATIONS` | [5, 10, 30] | `config/app.config.ts` | Durate selezionabili (secondi) |
| `EPHEMERAL_DEFAULT_DURATION` | 10 | `config/app.config.ts` | Durata default effimera |
| `EPHEMERAL_SERVER_TTL_HOURS` | 24 | `config/app.config.ts` | TTL blob sul server |

## Errori Signal Protocol

Errori critici nel decrypt e strategia di recovery:

| Codice | Nome | Contesto | Strategia |
|---|---|---|---|
| 6 | `InvalidMessage` | Pair-wise | **NON** fare `recoverSession()` — creerebbe una nuova sessione e tutti i messaggi in-flight cifrati con la vecchia sessione fallirebbero. Log + return false. |
| 11 | `invalidKey` | Pair-wise | Pre-key mancante. `recoverSession()` + `refreshPreKeysIfNeeded()`. Messaggio corrente perso, sessione recuperata per i futuri. **Identity gating (B-03):** `recoverSession()` separa fetch e apply delle remote keys; tra i due chiama `SignalProtocol.checkIdentityKeyChanged(remoteUserId, newIdentityKey)`. Lancia `IdentityKeyMismatchError` (esportata da `session.service.ts`) + invoca `handleIdentityKeyChanged()` se: (a) `changed: true` (server propone una identity diversa dalla trusted), oppure (b) il record `sessionRepository` esiste già — quindi la fiducia era stata stabilita in passato — ma il native ora segnala `No identity saved yet` o lancia `Session not initialized` (identity sparita dallo store nativo: corruzione/reinstall/MITM). In entrambi i casi `setRemoteUserKeys` NON viene chiamato, la vecchia sessione resta intatta. `setSession` propaga lo stesso errore senza ricreare la sessione (no silent identity rotate). TOFU consentito **solo** quando non esiste un record di sessione in DB → genuino primo contatto. |
| 12 | `UntrustedIdentity` | Pair-wise | Possibile MITM. `handleIdentityKeyChanged()` → security alert nello store. Nessun recovery automatico. |
| 19 | No sender key state | Sender key | `fetchAndProcessPendingSenderKeys()` → retry decrypt (1 volta). Se fallisce ancora → messaggio perso. |

## API Endpoints principali

Base URL: `EXPO_PUBLIC_API_URL` (default `https://api.tillit.cc`). JWT in header `Authorization`.

| Gruppo | Metodo | Path | Descrizione |
|---|---|---|---|
| Auth | POST | `/auth/challenge` | Richiede nonce |
| Auth | POST | `/auth/identity` | Firma nonce → JWT |
| Auth | POST | `/auth/token/push` | Registra push token |
| Chat | GET | `/chat` | Lista room |
| Chat | PUT | `/chat` | Crea room |
| Chat | POST | `/chat/{code}` | Join via invite code |
| Chat | DELETE | `/chat/{id}` | Elimina room (admin) o esci (non-admin in stanza amministrata). Response: `{ action: 'deleted' \| 'left' }` |
| Chat | DELETE | `/chat/{roomId}/message/{messageId}` | Elimina messaggio per tutti |
| Chat | GET | `/chat/{id}/members` | Lista membri |
| Keys | POST | `/keys` | Upload public key bundle |
| Keys | GET | `/keys/status/self` | Stato chiavi sul server |
| Keys | GET | `/keys/{userId}` | Chiavi pubbliche utente remoto |
| SK | POST | `sender-keys/initialize/{roomId}` | Inizializza sender key |
| SK | POST | `sender-keys/distribute/{roomId}` | Distribuisci sender key cifrate |
| SK | GET | `sender-keys/{roomId}` | Sender key pendenti |
| Auth | GET | `/auth/status` | Health check: `ok` / `banned` / `unauthorized` (no JWT guard) |
| Auth | DELETE | `/auth/account` | Elimina account + tutti i dati associati (GDPR / Apple 5.1.1(v)) |
| Mod | POST | `/moderation/report` | Segnala messaggio o utente (DSA compliance) |

## Modulo nativo — API principali

**File:** `modules/signal-protocol/src/index.ts`

Funzioni più usate nei servizi:

| Funzione | Usata in | Descrizione |
|---|---|---|
| `initializeIdentity(deviceId, name)` | login | Genera identity, signed pre-key, 100 pre-keys, 100 kyber pre-keys |
| `loadStoredLocalUser()` | login | Carica chiavi dal Keychain |
| `authenticate(reason)` | login, locked | Sblocco biometrico (LAContext) |
| `lock()` | app-init | Blocca Keychain (background) |
| `setRemoteUserKeys(params)` | session.service | Salva chiavi utente remoto |
| `establishSession(userId)` | session.service | Crea sessione Signal |
| `resumeSession(userId, name, deviceId)` | session.service | Riprende sessione esistente |
| `encryptMessage(msg, userId)` | chat.service | Cifra messaggio (Double Ratchet) |
| `decryptMessage(msg, userId)` | chat.service | Decifra messaggio. Auto-establishes sessione se non esiste (PreKeySignalMessage → X3DH) |
| `createSenderKeySession(roomId, distId)` | sender-key.service | Crea sender key di gruppo |
| `encryptGroupMessage(msg, roomId, distId)` | sender-key.service | Cifra con sender key |
| `decryptGroupMessage(ct, roomId, senderId, senderDeviceId?)` | sender-key.service | Decifra sender key. `senderDeviceId` opzionale (fallback a 1) |
| `replenishPreKeys(startId, count)` | session.service | Genera nuove pre-keys |
| `rotateSignedPreKey()` | session.service | Ruota signed pre-key |
| `signWithIdentityKey(data)` | auth.store | Firma nonce per challenge-response |
| `getFullPublicBundle()` | session.service | Bundle completo per upload al server |
| `checkDeviceSecurity()` | auth.store | Verifica passcode/biometria dispositivo |

## Modulo nativo Tor Proxy — API principali

**File:** `modules/tor-proxy/src/index.ts`

| Funzione | Usata in | Descrizione |
|---|---|---|
| `start()` | tor.service | Avvia daemon Tor, ritorna `{ socksPort }` |
| `stop()` | tor.service | Ferma daemon Tor |
| `getStatus()` | tor.service | Ritorna `stopped \| connecting \| bootstrapping \| connected` |
| `getBootstrapProgress()` | tor.service | Progresso bootstrap 0-100 |
| `httpRequest(config)` | tor-axios-adapter | HTTP via SOCKS5 (URLSession iOS, OkHttp Android) |
| `openWebSocket(url, protocols?)` | tor-websocket | WebSocket via SOCKS5, ritorna wsId |
| `sendWebSocket(wsId, data)` | tor-websocket | Invia dati su WebSocket Tor |
| `closeWebSocket(wsId, code?)` | tor-websocket | Chiude WebSocket Tor |

**Eventi nativi:** `onBootstrapProgress`, `onWebSocketMessage`, `onWebSocketOpen`, `onWebSocketClose`, `onWebSocketError`

## Comandi

```bash
# Sviluppo
npx expo start                # Avvia dev server
npx expo run:ios              # Build e run su iOS
npx expo run:android          # Build e run su Android

# Type check
npx tsc --noEmit              # Verifica tipi senza emettere file
```

## Problemi noti

- **Push notifications su iOS Simulator**: non funzionano per limitazione iOS. Usare device fisico. Errore: `non è stata trovata nessuna stringa di autorizzazione "aps-environment" valida`.
- **SafeAreaView deprecato**: usare `react-native-safe-area-context` al posto di quello di React Native.

## Note per lo sviluppo

### Arti xcframework (iOS Tor)

Il modulo `tor-proxy` su iOS usa un `arti.xcframework` custom (~250MB) compilato con la feature `onion-service-client` + `allow_onion_addrs` abilitati. Il framework **non è nel repo** — viene scaricato automaticamente da GitHub Releases durante `pnpm install` (via `scripts/download-arti.sh`).

**Setup per nuovi sviluppatori:**
1. `pnpm install` → scarica automaticamente `arti.xcframework` dalla release
2. Se il download fallisce, compilare localmente: `./scripts/build-arti-xcframework.sh`
   - Prerequisiti: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`

**Aggiornare la versione di Arti:**
1. Aggiornare `ARTI_MOBILE_VERSION` in `scripts/build-arti-xcframework.sh`
2. Lanciare `./scripts/build-arti-xcframework.sh` → genera `modules/tor-proxy/ios/arti.xcframework`
3. Comprimere: `cd modules/tor-proxy/ios && zip -r arti.xcframework.zip arti.xcframework`
4. Creare una GitHub Release con il tag aggiornato e caricare `arti.xcframework.zip`:
   ```bash
   gh release create tor-arti-X.Y.Z \
     --title "Arti X.Y.Z (onion-service-client)" \
     --notes "Custom build with onion-service-client + allow_onion_addrs" \
     arti.xcframework.zip
   ```
5. Aggiornare `RELEASE_TAG` in `scripts/download-arti.sh` con il nuovo tag

---

- Il modulo Signal Protocol è nativo e custom (`/modules/signal-protocol`). Gestisce tutte le operazioni crittografiche nel keystore nativo.
- Lo store chat mantiene max 200 messaggi in memoria per room (paginazione).
- Il QueueService gestisce l'invio offline: i messaggi falliti vengono accodati e reinviati alla riconnessione del socket.
- L'API backend è accessibile tramite `APIService` con token gestito in `expo-secure-store`.
- **messageQueue serializza TUTTE le operazioni Signal Protocol** (`chatService.messageQueue`). Il modulo nativo non è thread-safe — operazioni concorrenti corrompono il ratchet state. Non modificare i code paths di encrypt/decrypt senza comprendere la serial queue.
- **Non fare `recoverSession()` su Error 6** (InvalidMessage): distruggerebbe la sessione e renderebbe indecifrabili tutti i messaggi in-flight.
- **Session establishment semplificata**: il joiner stabilisce la sessione e invia un pacchetto `SESSION_ESTABLISHED` targettizzato. Il ricevente ottiene la sessione automaticamente dal decrypt del PreKeySignalMessage (X3DH). Nessun lock, nessuna race condition, nessuna doppia session establishment. Fallback: `user_joined` (online), `syncRoomMembersAndSessions` (riconnessione), e auto-establishment nativo di libsignal su `decryptMessage` (ultimo fallback).
- **Moduli nativi `decryptMessage` — auto-establishment**: sia iOS (`SignalProtocolModule.swift`) che Android (`SignalProtocolModule.kt`) creano automaticamente un `EncryptedSession` con `remoteUser: nil` quando `decryptMessage` viene chiamato per un `remoteUserId` senza sessione pre-esistente. Questo permette a libsignal di processare PreKeySignalMessages e auto-stabilire la sessione inversa — comportamento nativo X3DH del Signal Protocol.
- `npx tsc --noEmit` per verifica tipi prima di committare.
