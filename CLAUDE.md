# TilliT Native

> Aggiorna questo file solo per cambi strutturali (nuove feature/route/dipendenze, refactor architetturali). Per dettagli implementativi punta ai file di codice o alle spec in `_shared/`.

## Overview

App di messaggistica E2E (Signal Protocol). Chat 1-to-1 e di gruppo con strategia adattiva: pair-wise se membri <4, sender keys se ≥4.

## Tech Stack

Expo v54 / RN v0.81 · Expo Router v6 · NativeWind v4 · Zustand v5 + Immer · Drizzle ORM + expo-sqlite (SQLCipher) · Socket.IO v4 · Axios · `modules/signal-protocol` (nativo) · `modules/secure-view` (screenshot protection) · `modules/tor-proxy` (Tor embedded) · expo-secure-store · react-native-gesture-handler v2.28 · react-native-reanimated v4.1 · expo-haptics · expo-share-intent.

## Struttura

```
app/                 # Routing (Expo Router)
  _layout.tsx        # Auth redirect + GestureHandlerRootView + ShareIntentProvider
  +native-intent.ts  # Deep link / share intent intercept
  (auth)/login.tsx
  (tabs)/            # index (lista chat), profile
  chat/[id].tsx
  join-room.tsx, share-target.tsx, link-device.tsx, claim-device.tsx
  locked.tsx, unsecure.tsx

src/
  components/        # chat/ (ChatList, MessageBubble, MessageBar, SwipeableMessage…), modals/, ui/
  config/app.config.ts
  stores/            # auth.store, chat.store, app.store, server.store, device.store
  services/          # api, chat (~1550 righe, core), socket, session, sender-key, queue,
                     # app-init, health-check, device, tor, tor-axios-adapter, tor-websocket,
                     # server-registry, diagnostics
  db/                # schema.ts, client.ts (createTables + applyMigrations), repositories/
  hooks/, utils/, types/, i18n/

modules/             # signal-protocol, secure-view, tor-proxy
constants/theme.ts
```

## Architettura essenziale

### Auth flow

`App start → checkDeviceSecurity → /unsecure | /locked | loadStoredToken`. Auth è basata su **identity locale** (`userId` in SecureStore), NON sul JWT server: token scaduto + `userId` presente ⇒ `isAuthenticated=true` (auth server posticipata al bootstrap via `connectAll()`). Dopo auth → `/(tabs)` → `appInitService.initialize()` (bootstrap idempotente: 10 step, recoverStuckMessages → loadSessions → init chat → loadRooms → connectAll → refreshPreKeys → registerPush → lifecycle listeners). DB SQLCipher inizializzato **dopo** unlock biometrico (chiave in protected storage del native module).

### Per-device server-auth (ADR-0010 + ADR-0011)

Auth al server in **due firme** sulla stessa challenge domain-separated: `signWithIdentityKey` (identità E2E condivisa) **+** `signWithDeviceAuth` (**device-auth keypair** Curve25519 per-device, distinta dall'identità, mai trasmessa, fuori dall'E2E). La pubblica (`getDeviceAuthPublicKey`) viaggia in `POST /keys` (`deviceAuthPublicKey`) → TOFU-bind server-side. Chiude il #4: un linked device non può più rivendicare `deviceId: 1`. **Lazy-gen** native al primo accesso → copre upgrade/fresh/linked senza migrazione. Backward-compat: server in **transition mode** finché la chiave non è bound (flag server `DEVICE_AUTH_REQUIRED`, OQ-5). Errori: `401 DEVICE_AUTH_INVALID/REQUIRED`, `409 DEVICE_AUTH_MISMATCH` → `src/utils/auth-errors.ts`.

**Niente recovery del primary (ADR-0011)**: il flusso `recoverPrimary` è stato rimosso. Perdere la device-auth key del primary non è recuperabile lato server → l'utente **ricrea l'account** (UI in `login.tsx`: `presentDeviceAuthError` mostra `auth.primaryUnrecoverableMsg` sul primary, `auth.deviceAuthInvalidMsg` re-pair sui linked). **Liveness lock (ADR-0011)**: se il primary (`deviceId=1`) resta inattivo oltre soglia server (default 7gg), i linked sono bloccati con `401 PRIMARY_INACTIVE` (REST) / `connect_error` `PRIMARY_INACTIVE` (WS). Stato **temporaneo e reversibile** (no logout/revoca): `isPrimaryInactiveError` → alert `auth.primaryInactive*` su login; `socket.service` flagga `server.store.primaryInactiveServers` e lascia riprovare l'auto-reconnect, clear al primo `connect` riuscito (badge in `ServerStatusModal`). Spec: `_shared/api/per-device-server-auth.md`, `_shared/decisions/0010-…md`, `_shared/decisions/0011-…md`.

### onConnected (per ogni (ri)connessione socket)

`syncAllRoomsFromBackend → syncRoomMembersAndSessions → queueService.forceProcess → fetchPendingSenderKeysForAllRooms → refreshPreKeysIfNeeded → retrySendingMessages`.

### Crittografia

- **Pair-wise** (<4 membri): cifratura per destinatario via Signal Protocol Double Ratchet.
- **Sender Keys** (≥4 membri): un solo ciphertext, distribuzione chiavi cifrate. Rotazione a 1000 msg o 7 giorni. `senderDeviceId` (opzionale, fallback `1`) passato a `processSenderKeyDistribution` / `decryptGroupMessage` per evitare key collision multi-device. Spec backend: `_shared/api/sender-key-device-id.md`.
- Chiavi private mai fuori dal device (Keychain/Keystore).

### Session establishment (X3DH asimmetrico)

Solo il joiner stabilisce la sessione; il membro esistente la riceve auto-creata dal decrypt del PreKeySignalMessage (libsignal nativo). Tre livelli di copertura: (1) packet `SESSION_ESTABLISHED` targettizzato dal joiner, (2) `syncRoomMembersAndSessions` a ogni reconnect, (3) auto-establishment nativo in `decryptMessage` (iOS + Android creano `EncryptedSession` con `remoteUser: nil` quando manca). Nessuna race grazie alla `messageQueue` serializzata.

### Multi-device pairing (wire v2.1)

Direzione: new device mostra QR, primary scansiona. Safety number simmetrico **pre-commit** via endpoint intermedio `/link/share-pubkey` (vedi ADR-0003 + ADR-0004 e `_shared/api/multi-device-linking.md`). File chiave: `app/link-device.tsx`, `app/claim-device.tsx`, `src/services/device.service.ts`, `src/stores/device.store.ts`. Deep link `tillit://link?v=2&i=…&s=…&e=…` → `+native-intent.ts` → `/link-device`.

### Multi-device send/receive

- **Send fan-out**: per ogni `(peerUserId, deviceId)` un ciphertext, emessi nello stesso `sendMessage` con `recipients[]` **top-level** (non annidato in `message.payload`, altrimenti il backend cade sul path legacy). `userId` numerico (validation pipe). Spec: `_shared/api/multi-device-fanout.md`, `_shared/specs/multidevice-send-wire-shape.md`. Routing in `chat.service.emitSendMessage` (fan-out vs legacy sender-key).
- **Device map refresh** (3 livelli): refresh in `syncRoomMembersAndSessions`, persistenza CSV in `session.remote_known_devices` (migration v4), push socket `peerDeviceLinked` (spec `_shared/api/peer-device-linked.md`). Self-refresh `ownUserId` necessario per il self-fanout (members API filtra il requester).
- **Receive**: `decryptMessage(body, remoteUserId, senderDeviceId)`. Senza `senderDeviceId` il native faceva default a 1 → protobuf decode error su messaggi da linked device. Self-fanout drop SOLO con `device_id_from` esplicitamente numerico === `ownDeviceId`; altrimenti dedup downstream.
- **Read sync self-fanout**: `processControlPacket MESSAGE_READ` con `isSelfFanout` su target incoming → `markAsRead` (idempotente) + `recomputeRoomUnread` + `refreshOsBadge`. Spec: `_shared/api/multi-device-read-sync.md`, ADR `_shared/decisions/0006-multi-device-read-sync.md`.

### Ephemeral images

Timer 5/10/30s, AES su blob (upload `POST /media/ephemeral`, TTL 24h) + Signal-encrypt metadata. View in `SecureView` nativo (screenshot = nero). Mai su disco. One-time download (`POST /media/:id/viewed`). Tipo `EPHEMERAL_IMAGE`. File: `modules/secure-view/`, `EphemeralImageViewerModal.tsx`, `chat.service.sendEphemeralImageMessage`.

### Stanze amministrate, DSA, account deletion

- `room.administered`: admin (creatore) elimina per tutti, non-admin esce solo. `DELETE /chat/:id → { action: 'deleted' | 'left' }`. Eventi socket top-level `roomDeleted` / `userLeftRoom`.
- DSA report: `POST /moderation/report` (con `messageId` opzionale). Health check `GET /auth/status` → `ok | banned | unauthorized`. Server bannato: socket non si connette, `ServerStatusModal` mostra badge "Inaccessibile". App accessibile anche con default bannato (auth basata su identity locale).
- Account deletion (`appInitService.deleteAccount`): `DELETE /auth/account` su ogni server registrato (best-effort) → `SignalProtocol.clearIdentity()` → wipe SecureStore + SQLite → reset store → `/login`. Spec `_shared/api/auth-account-delete.md`.

### Tor `.onion`

`modules/tor-proxy` (iOS Tor.framework v408 / Android tor-android v0.4.8.19) espone HTTP + WebSocket via SOCKS5 locale, perché RN non supporta SOCKS proxy nativamente. `useTor` per-server: Axios adapter custom + `TorWebSocket` iniettata in Socket.IO. Tor parte solo se almeno un server `.onion` esiste, resta attivo per la vita dell'app. Push token **NON** registrato su server Tor (leak IP). Nessun fallback clearnet per `.onion`. DB: `server.is_tor` (migration v2). Setup iOS: `arti.xcframework` (~250MB) scaricato da GitHub Release via `scripts/download-arti.sh` durante `pnpm install`.

### Deep link e share

- Invite room: `https://tillit.cc/roomcode/{CODE}` → `pendingInviteCode` in app.store → `/join-room`.
- Share intent: dataUrl=`tillitnativeShareKey` → `/share-target` (lista room ordinate per attività) → `sendImageMessage`.

### Anteprime messaggi (`UserMessageType`)

`src/utils/message-preview.ts → getMessagePreview` è single source of truth. Per ogni nuovo tipo aggiornare: helper, `MessageBubble.renderContent`, `chat.service.extractUserBody`, i18n (it/en), e verificare lista chat / reply bar / reply preview / push.

### DB migrations

Due livelli in `src/db/client.ts`: `createTables()` con `CREATE TABLE IF NOT EXISTS` (schema corrente, no-op su DB esistenti) + `applyMigrations()` (array `MIGRATIONS` con `version`/`statements`, gated da `PRAGMA user_version`). Nuova migrazione: aggiungi colonna in `createTables`, append entry in `MIGRATIONS`, aggiorna `src/db/schema.ts`. **Non usare Drizzle migrations** (incompatibili con `CREATE TABLE IF NOT EXISTS`).

## Convenzioni

- **Logger**: `import { logger } from '@/utils/logger'`. Mai `console.log`. Output su console + Zustand `app.store.connectionLog` (max 200), visibile via 10-tap sull'icona connessione. Quando i log diagnostici on-device sono ON, il logger inoltra ogni riga (già sanitizzata) al ring buffer di `diagnostics` via `setDiagSink`.
- **Diagnostica on-device (frontend-0028)**: `diagnostics` singleton (`services/diagnostics.service.ts`) — opt-in (toggle in Impostazioni, default OFF, **zero backend**). Ring buffer persistente bounded (2000 entry / 24h, `documentDirectory/diagnostics/buffer.jsonl`) di entry strutturate `{ts, level, category, event, ctx}` con `serverId` nel ctx. Strumentati: auth + keystore unlock (`server-registry`), session establish + `identityMismatch` (`session.service`), control packet sent/drop (`chat.service`), socket connect/disconnect/error (`socket.service`). **Redazione**: `utils/diag-redact.ts` (`redactCtx` in ingresso + `reRedactText` in export) elimina token base64/hex/JWT lunghi — mai chiavi, ciphertext, token o contenuti. Export via share sheet (re-redaction finale), wipe. Init in `appInitService.initialize` (step 0). Solo identificatori/metadati: vedi regole nella spec.
- **Singleton services**: `apiService`, `chatService`, `socketService`, `sessionService`, `senderKeyService`, `queueService`, `appInitService`, `healthCheckService`, `deviceService`, `torService`, `diagnostics`.
- **Repository pattern**: accesso DB solo via `src/db/repositories/`.
- **Stores**: `useAuthStore`, `useAppStore`, `useChatStore`, `useServerStore`, `useDeviceStore`. Fuori dai componenti: `useStore.getState()`.
- **Serial queue (`chatService.messageQueue`)**: serializza **tutte** le op Signal Protocol. Il native NON è thread-safe — concorrenza corrompe il ratchet. NON rimuovere.
- **Fuori dalla queue di proposito**: `socket.sendPacket` dei control packet gira detached (network emit + ack-await), così un ack server lento non blocca i `sendMessage`. In `sendControlPacket` solo `encryptStep` è sulla coda. Vedi `_shared/tasks/frontend-0015-…md`.
- **Receipt coalescing**: `markRoomAsRead` raggruppa unread per `idUserFrom`, emette un `MESSAGE_READ` per sender con `id_messages[]` (fallback `id_message` per N=1). `handleUserMessage`/`handleSenderKeyMessage` inviano UN packet per messaggio (READ se room aperta, altrimenti DELIVERED — READ implica DELIVERED). Spec: `_shared/api/control-packet-read-coalesced.md`.
- **`resumeSession` memoization (native)**: cache hit ritorna `"Session already warm"` senza riaprire gli store cifrati né sovrascrivere il ratchet state. Recovery esplicito passa per `setRemoteUserKeys`.

## Costanti chiave

| Costante | Valore | File |
|---|---|---|
| `SENDER_KEY_THRESHOLD` | 4 | `config/app.config.ts` |
| `SENDER_KEY_MESSAGE_ROTATION_THRESHOLD` | 1000 | `config/app.config.ts` |
| `SENDER_KEY_ROTATION_THRESHOLD_SECONDS` | 7d | `config/app.config.ts` |
| `PREKEY_THRESHOLD` / `PREKEY_BATCH_SIZE` | 10 / 50 | `session.service.ts` |
| `SIGNED_PREKEY_ROTATE_DAYS` | 30 | `session.service.ts` |
| `LOCK_TIMEOUT` | 30s | `app-init.service.ts` |
| `MAX_RETRY_AGE_MS` | 2h | `chat.service.ts` |
| `MAX_MESSAGES` (in-memory per room) | 200 | `chat.store.ts` |
| `EPHEMERAL_DURATIONS` / `EPHEMERAL_DEFAULT_DURATION` | [5,10,30] / 10 | `config/app.config.ts` |
| `EPHEMERAL_SERVER_TTL_HOURS` | 24 | `config/app.config.ts` |

## Errori Signal Protocol (critici)

| Codice | Nome | Strategia |
|---|---|---|
| 6 | `InvalidMessage` (pair-wise) | **NON** `recoverSession()`: distruggerebbe la sessione e renderebbe indecifrabili i messaggi in-flight. Log + return false. |
| 11 | `invalidKey` (pair-wise) | Pre-key mancante. `recoverSession()` + `refreshPreKeysIfNeeded()`. **Identity gating (B-03)**: tra fetch e apply delle remote keys, `checkIdentityKeyChanged` → `IdentityKeyMismatchError` se identity diversa O record session già esistente ma native segnala identity sparita. TOFU solo se nessun record di sessione in DB. |
| 12 | `UntrustedIdentity` | Possibile MITM → `handleIdentityKeyChanged` (security alert). No recovery automatico. |
| 19 | No sender key state | `fetchAndProcessPendingSenderKeys` → retry 1 volta. Se fallisce ancora → messaggio perso. |

## API Endpoints

Base: `EXPO_PUBLIC_API_URL` (default `https://api.tillit.cc`). JWT in `Authorization`.

| Path | Note |
|---|---|
| `POST /auth/challenge`, `POST /auth/identity` | Challenge-response → JWT. `/auth/identity` porta **due firme**: `challengeSignature` (identità) + `deviceAuthSignature` (device-auth, ADR-0010) |
| `POST /auth/token/push` | Registra push token (skip per Tor) |
| `GET /auth/status` | Health check (no JWT) → `ok|banned|unauthorized` |
| `DELETE /auth/account` | GDPR / Apple 5.1.1(v) |
| `POST /auth/devices/link/init|share-pubkey|complete`, `GET /auth/devices/link/session/:id/result`, `GET/DELETE /auth/devices[/:id|/me]` | Multi-device pairing v2.1 |
| `GET/PUT /chat`, `POST /chat/:code`, `DELETE /chat/:id` (→ `{action: 'deleted'|'left'}`), `DELETE /chat/:roomId/message/:messageId`, `GET /chat/:id/members` | Chat |
| `POST /keys`, `GET /keys/status/self`, `GET /keys/:userId` | Bundle Signal. `POST /keys` porta `deviceAuthPublicKey` (TOFU-bind, ADR-0010). Nessun `recoverPrimary` (rimosso, ADR-0011) |
| `POST /sender-keys/initialize/:roomId|distribute/:roomId`, `GET /sender-keys/:roomId` | Sender keys |
| `POST /moderation/report` | DSA |
| `POST /media/ephemeral`, `POST /media/:id/viewed` | Ephemeral images |

## API native principali

**`modules/signal-protocol`** (`src/index.ts`): `initializeIdentity`, `loadStoredLocalUser`, `authenticate(reason)`, `lock()`, `setRemoteUserKeys`, `establishSession`, `resumeSession(userId, name, deviceId)`, `encryptMessage`, `decryptMessage(msg, userId, deviceId?)` (auto-establish PreKeySignalMessage via X3DH), `createSenderKeySession`, `encryptGroupMessage`, `decryptGroupMessage(ct, roomId, senderId, senderDeviceId?)`, `replenishPreKeys`, `rotateSignedPreKey`, `signWithIdentityKey`, `getDeviceAuthPublicKey`, `signWithDeviceAuth` (ADR-0010, device-auth keypair lazy-gen), `getFullPublicBundle`, `checkDeviceSecurity`, `checkIdentityKeyChanged`, `clearIdentity`.

**`modules/tor-proxy`** (`src/index.ts`): `start() → {socksPort}`, `stop`, `getStatus` (`stopped|connecting|bootstrapping|connected`), `getBootstrapProgress`, `httpRequest(config)`, `openWebSocket`, `sendWebSocket`, `closeWebSocket`. Eventi: `onBootstrapProgress`, `onWebSocketMessage|Open|Close|Error`.

## Comandi

```bash
npx expo start
npx expo run:ios
npx expo run:android
npx tsc --noEmit       # type check prima di committare
```

## Caveat critici

- **Error 6 ≠ recovery**: vedi tabella errori.
- **messageQueue è obbligatoria** per Signal Protocol (thread-safety nativa).
- **multi-device fan-out**: `recipients[]` top-level + `userId` numerico, altrimenti backend cade sul path legacy / rifiuta payload.
- **DB SQLCipher**: `initDatabase()` solo dopo unlock biometrico. Per wipe usa `wipeDatabaseFiles()` (la chiave vive dietro biometric ACL).
- **Push su iOS Simulator**: non funziona, usare device fisico.
- **SafeAreaView**: usare `react-native-safe-area-context`.
- **Arti xcframework** (iOS Tor): scaricato in `pnpm install`; per nuova versione vedi `scripts/build-arti-xcframework.sh` + `scripts/download-arti.sh` (aggiorna `RELEASE_TAG`).
