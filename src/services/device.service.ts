/**
 * Multi-device pairing orchestrator (wire v2).
 *
 * Wraps API + native + store calls into the two flows described in
 * `_shared/api/multi-device-linking.md` (v2):
 *
 * - **Primary side (scanner)**: scan QR → derive P_pub/P_priv →
 *   compute safety number (E_pub, P_pub, identityPub, primaryUserId)
 *   → user confirms → encrypt provisioning payload → POST /link/complete.
 *
 * - **New device side (show-QR)**: pick server origin → generate E_pub/E_priv
 *   → POST /link/init → render QR(tillit://link?v=2&i=…&s=…&e=…) → poll
 *   /link/session/:id/result → peek (decrypt + integrity) → user confirms
 *   safety number → consume (install identity) → publish bundle.
 *
 * The service is a singleton. UI screens import it directly, call the
 * action they need, and read state from `useDeviceStore`. The service
 * NEVER calls into a UI component or Zustand selector — it only mutates
 * the store via its actions, then UI re-renders.
 */

import SignalProtocol from 'signal-protocol';
import { logger } from '@/utils/logger';
import { getDefaultApi } from '@/services/auth-api-bridge';
import { serverRegistry } from '@/services/server-registry';
import { useDeviceStore } from '@/stores/device.store';
import {
  parseProvisioningLinkV2,
  buildProvisioningUrlV2,
  originsMatch,
} from '@/services/provisioning-link';
import type {
  DeviceInfo,
  ProvisioningLinkParams,
  LinkSessionResultResponse,
} from '@/types/device';

/** Poll interval for /link/session/:id/result, in milliseconds. */
const POLL_INTERVAL_MS = 2000;

/** Hard ceiling for polling: keeps us well clear of the server-side 5-min TTL. */
const POLL_HARD_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Strip libsignal's DJB framing prefix (`0x05`) from a base64-encoded X25519
 * public key, returning the raw 32-byte form. No-op when the input is
 * already 32 bytes raw (decoded length !== 33 or first byte !== 0x05).
 *
 * Used to:
 *   - send the BE the raw 32-byte form on `/link/init` and `/link/complete`
 *     (the backend validates `length === 32` strict);
 *   - feed the safety-number hash with `to_canonical(...)` per spec
 *     (`_shared/api/multi-device-linking.md`), so the SN computed by this
 *     client matches the one computed by clients that already strip the
 *     prefix (desktop after desktop-0011).
 */
function stripDjbPrefixB64(b64: string): string {
  if (!b64 || typeof b64 !== 'string') return b64;
  let binary: string;
  try {
    binary = atob(b64);
  } catch (e) {
    logger.warn('[DeviceService] stripDjbPrefixB64: atob failed for input len=' + b64.length);
    return b64;
  }
  logger.info(`[DeviceService] stripDjbPrefixB64 in: len(b64)=${b64.length} decoded=${binary.length}B firstByte=0x${binary.charCodeAt(0).toString(16)}`);
  if (binary.length === 33 && binary.charCodeAt(0) === 0x05) {
    const out = btoa(binary.slice(1));
    logger.info(`[DeviceService] stripDjbPrefixB64 out: len(b64)=${out.length}`);
    return out;
  }
  return b64;
}

class DeviceService {
  /** Active polling cancellation flags, keyed by sessionId. */
  private pollAborted = new Map<string, boolean>();

  /**
   * Resolvers registered by `confirmNewDeviceSafetyAndInstall` when the
   * user has tapped Match but the encrypted payload has not yet arrived
   * (wire v2.1 edge case — possible because the SN is now surfaced at
   * `pubkey-shared`, before /complete fires). The poll loop fulfills
   * these from `onCompletedReady` once `status: 'completed'` is received.
   * Keyed by sessionId; the rejecter is called from
   * `cancelNewDeviceLink` so the in-flight install promise resolves
   * cleanly on a user-initiated abort.
   */
  private payloadArrivalResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  /**
   * Release any pending `confirmNewDeviceSafetyAndInstall` waiter for the
   * given session with the supplied error. Idempotent — safe to call from
   * every poll-loop exit path (timeout, 404, 410, server-reported expired)
   * as well as cancellation. Without this, exiting `pollNewDeviceSessionResult`
   * with the user already past Match would leave the install promise
   * pending forever (memory leak + the UI never gets a verdict).
   */
  private rejectPayloadWaiter(sessionId: string | null | undefined, err: Error): void {
    if (!sessionId) return;
    const waiter = this.payloadArrivalResolvers.get(sessionId);
    if (!waiter) return;
    this.payloadArrivalResolvers.delete(sessionId);
    waiter.reject(err);
  }

  // ===================== PRIMARY SIDE (scanner) =====================

  /**
   * Parse a `tillit://link?v=2&i=<sessionId>&s=<base64url(server)>&e=<base64url(E_pub)>` URL
   * into structured params. Delegated to the pure helper module so unit
   * tests can exercise the parser without the native/axios chain.
   */
  parseProvisioningLink(url: string): ProvisioningLinkParams | null {
    return parseProvisioningLinkV2(url);
  }

  /**
   * Primary scanner flow entry point. Validates that the scanned QR
   * targets the same server the primary is currently authenticated
   * against, generates the per-pairing ephemeral keypair, computes the
   * safety number, then in wire v2.1 deposits `P_pub` on the session via
   * `POST /auth/devices/link/share-pubkey` BEFORE surfacing the SN to
   * the user. The share-pubkey step lets the new device compute its own
   * SN (in parallel) before either side commits with /complete — it is
   * what turns the SN comparison from "post-commit verify with rollback"
   * back into "pre-commit gate". See ADR-0004.
   *
   * Phase transitions: scanning → safetyCheck | error.
   */
  async handlePrimaryScannedQR(parsed: ProvisioningLinkParams): Promise<void> {
    const store = useDeviceStore.getState();
    store.setPrimaryScannedQR({
      sessionId: parsed.sessionId,
      serverOrigin: parsed.serverOrigin,
      newDeviceEphemeralPub: parsed.newDeviceEphemeralPub,
    });

    try {
      // Server-origin check. The primary must only complete a pairing
      // that targets its own server (otherwise the /share-pubkey call
      // would be against a session that does not exist on this backend).
      const ownOrigin = serverRegistry.getDefaultServer()?.apiUrl;
      if (!ownOrigin || !originsMatch(ownOrigin, parsed.serverOrigin)) {
        logger.warn(
          '[DeviceService] serverOrigin mismatch:',
          { own: ownOrigin, qr: parsed.serverOrigin },
        );
        store.setPrimaryError('SERVER_MISMATCH');
        return;
      }

      const keypair = await SignalProtocol.generateProvisioningKeypair();
      store.setPrimaryEphemeral(keypair.publicKey, keypair.privateKey);

      const identity = await SignalProtocol.getPublicIdentity();
      const api = getDefaultApi();
      const tokenPayload = await api.getTokenPayload();
      const primaryUserId = String(tokenPayload?.sub ?? '');
      if (!primaryUserId) {
        throw new Error('No primaryUserId available from JWT');
      }

      // Safety number is hashed over `to_canonical(...)` of each public key
      // per spec — i.e. 32-byte raw X25519. libsignal mobile serializes its
      // own pub keys as 33-byte DJB framed (0x05-prefixed); the desktop now
      // sends 33B in the QR too. Strip the prefix here so both ends compute
      // the SN over the same bytes.
      const { safetyNumber } = await SignalProtocol.getPairingSafetyNumber(
        stripDjbPrefixB64(parsed.newDeviceEphemeralPub),
        stripDjbPrefixB64(keypair.publicKey),
        stripDjbPrefixB64(identity.identityPublicKey),
        primaryUserId,
      );
      logger.info('[DeviceService] primary scanned QR, safety number computed');

      // Wire v2.1: deposit P_pub on the session so the new device can
      // compute its own SN (via /result polling) before /complete. Errors
      // here surface as `SHARE_PUBKEY_*` codes in the phase machine.
      // BE validates `primaryEphemeralPublicKey.length === 32`; strip the
      // DJB framing libsignal mobile adds.
      try {
        await api.linkSharePubkey({
          sessionId: parsed.sessionId,
          primaryEphemeralPublicKey: stripDjbPrefixB64(keypair.publicKey),
        });
      } catch (sharePubkeyErr: any) {
        logger.error(
          '[DeviceService] linkSharePubkey failed:',
          sharePubkeyErr?.message ?? sharePubkeyErr,
        );
        const status = sharePubkeyErr?.response?.status;
        const code = mapSharePubkeyError(status);
        store.setPrimaryError(code);
        return;
      }

      // Only now expose the SN to the user. From here the new device is
      // also (or about to be) at its own `safetyCheck` step.
      store.setPrimarySafetyNumber(safetyNumber);
    } catch (err: any) {
      logger.error('[DeviceService] handlePrimaryScannedQR failed:', err?.message ?? err);
      store.setPrimaryError('SAFETY_NUMBER_FAILED');
    }
  }

  /**
   * User confirmed the safety number on the primary side. Encrypt the
   * provisioning payload using the new device's ephemeral pub, then
   * deposit it via POST /auth/devices/link/complete.
   *
   * Phase transitions: safetyCheck → completing → done | error.
   */
  async confirmPrimarySafetyAndComplete(): Promise<void> {
    const store = useDeviceStore.getState();
    const pairing = store.pairingPrimary;
    if (!pairing || pairing.phase !== 'safetyCheck') {
      throw new Error('confirmPrimarySafetyAndComplete called in invalid phase');
    }
    if (
      !pairing.sessionId ||
      !pairing.newDeviceEphemeralPub ||
      !pairing.primaryEphemeralPriv ||
      !pairing.primaryEphemeralPub
    ) {
      throw new Error('confirmPrimarySafetyAndComplete: missing pairing material');
    }

    store.setPrimaryPhase('completing');
    try {
      const api = getDefaultApi();
      const tokenPayload = await api.getTokenPayload();
      const primaryUserId = String(tokenPayload?.sub ?? '');
      if (!primaryUserId) {
        throw new Error('No primaryUserId available from JWT');
      }

      const settings = (await import('@/stores/app.store')).useAppStore.getState().settings;
      const primaryName = settings.username || undefined;

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        pairing.newDeviceEphemeralPub,
        pairing.primaryEphemeralPriv,
        primaryUserId,
        primaryName,
      );

      // Wire v2.1: /complete no longer carries `primaryEphemeralPublicKey`
      // — the server already received it via /share-pubkey (called from
      // `handlePrimaryScannedQR`). Backend expects session.status to be
      // `pubkey-shared` here; if not, 409 SESSION_NOT_PUBKEY_SHARED.
      const completeRes = await api.linkComplete({
        sessionId: pairing.sessionId,
        encryptedPayload: ciphertext,
      });

      store.setPrimaryAssignedDeviceId(completeRes.assignedDeviceId);
      logger.info('[DeviceService] primary complete, assignedDeviceId:', completeRes.assignedDeviceId);
    } catch (err: any) {
      logger.error('[DeviceService] confirmPrimarySafetyAndComplete failed:', err?.message ?? err);
      const status = err?.response?.status;
      const errCode = err?.response?.data?.code;
      const code =
        status === 404
          ? 'SESSION_NOT_FOUND'
          : status === 409
            ? (errCode === 'SESSION_NOT_PUBKEY_SHARED'
                ? 'SESSION_NOT_PUBKEY_SHARED'
                : 'SESSION_CONFLICT')
            : status === 410
              // L1: same distinction as the new-device poll loop —
              // SESSION_ALREADY_CONSUMED maps to "QR already used"
              // wording so the user knows a re-attempt with the same
              // QR will keep failing.
              ? (errCode === 'SESSION_ALREADY_CONSUMED'
                  ? 'SESSION_ALREADY_CONSUMED'
                  : 'SESSION_EXPIRED')
              : 'COMPLETE_FAILED';
      store.setPrimaryError(code);
      throw err;
    }
  }

  /**
   * User pressed "Don't match" on the primary side or backed out. The
   * server-side session expires naturally after 5 min; we just clear
   * local state.
   */
  cancelPrimaryPairing(): void {
    useDeviceStore.getState().clearPrimaryPairing();
  }

  // ===================== NEW-DEVICE SIDE (show QR) =====================

  /**
   * Start the new-device pairing flow:
   *
   *   1. Generate the per-pairing X25519 ephemeral keypair.
   *   2. POST /auth/devices/link/init (anonymous) with our ephemeral pub.
   *   3. Build the v=2 provisioning URL and park it in the store; the
   *      UI renders it as QR while `pollNewDeviceSessionResult` runs in
   *      the background.
   *
   * Phase transitions: idle → init → waiting | error.
   */
  async startNewDeviceLink(deviceName?: string): Promise<void> {
    const store = useDeviceStore.getState();
    const ownOrigin = serverRegistry.getDefaultServer()?.apiUrl;
    if (!ownOrigin) {
      logger.error('[DeviceService] startNewDeviceLink: no default server configured');
      store.startNewDeviceLink('');
      store.setNewDeviceError('NO_SERVER');
      return;
    }
    store.startNewDeviceLink(ownOrigin);

    try {
      const keypair = await SignalProtocol.generateProvisioningKeypair();
      store.setNewDeviceEphemeral(keypair.publicKey, keypair.privateKey);

      const api = getDefaultApi();
      // BE validates `ephemeralPublicKey.length === 32`; strip the DJB
      // prefix that libsignal mobile adds. The QR keeps the 33B canonical
      // form (44 char base64url) to match the wire spec after desktop-0011.
      const initRes = await api.linkInit({
        ephemeralPublicKey: stripDjbPrefixB64(keypair.publicKey),
        deviceName,
        userAgent: undefined,
      });

      const provisioningUrl = buildProvisioningUrlV2({
        sessionId: initRes.sessionId,
        serverOrigin: ownOrigin,
        ephemeralPublicKey: keypair.publicKey,
      });

      store.setNewDeviceSession({
        sessionId: initRes.sessionId,
        expiresAt: initRes.expiresAt,
        provisioningUrl,
      });
      logger.info('[DeviceService] new-device link initialized, expires', initRes.expiresAt);
    } catch (err: any) {
      logger.error('[DeviceService] startNewDeviceLink failed:', err?.message ?? err);
      const status = err?.response?.status;
      const code =
        status === 400
          ? 'INVALID_EPHEMERAL_KEY'
          : status === 429
            ? 'TOO_MANY_LINKS'
            : 'INIT_FAILED';
      store.setNewDeviceError(code);
      throw err;
    }
  }

  /**
   * Poll /link/session/:id/result. Wire v2.1 has two non-terminal states
   * that matter to us:
   *
   *   - `pubkey-shared` → the primary has called /share-pubkey with
   *     `P_pub`. The server also surfaces `primaryUserId` and
   *     `identityKeyPub` (lookup of the primary's published bundle). We
   *     compute the SN immediately, transition the UI to `safetyCheck`,
   *     and KEEP POLLING for the eventual `completed`.
   *   - `completed` → the primary has called /complete; we now have the
   *     ciphertext. We peek it, verify the identityKeyPub matches the
   *     one received in `pubkey-shared` (anti-tamper), and either
   *     install immediately (if the user has already tapped Match) or
   *     hold the payload until they do.
   *
   * Phase transitions: waiting → polling → safetyCheck → (installing | error).
   */
  async pollNewDeviceSessionResult(): Promise<void> {
    const initial = useDeviceStore.getState().pairingNewDevice;
    if (!initial?.sessionId) {
      throw new Error('pollNewDeviceSessionResult called without an active session');
    }
    const sessionId = initial.sessionId;
    this.pollAborted.set(sessionId, false);
    useDeviceStore.getState().setNewDevicePhase('polling');
    const deadline = Date.now() + POLL_HARD_TIMEOUT_MS;
    const api = getDefaultApi();
    let pubkeySharedHandled = false;

    try {
    while (!this.pollAborted.get(sessionId)) {
      if (Date.now() > deadline) {
        useDeviceStore.getState().setNewDeviceError('POLL_TIMEOUT');
        this.rejectPayloadWaiter(sessionId, new Error('POLL_TIMEOUT'));
        return;
      }
      let res: LinkSessionResultResponse;
      try {
        res = await api.linkSessionResult(sessionId);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
          useDeviceStore.getState().setNewDeviceError('SESSION_NOT_FOUND');
          this.rejectPayloadWaiter(sessionId, new Error('SESSION_NOT_FOUND'));
          return;
        }
        if (status === 410) {
          // L1: 410 collapses to two distinct user-facing situations.
          // The server marks the session `consumed_at` after the first
          // successful `completed` read and rejects further polls with
          // `SESSION_ALREADY_CONSUMED`. That is operationally different
          // from a session that timed out before any device ever read it
          // (`SESSION_EXPIRED`): the first is "you've already used this
          // QR — start a new one", the second is "the QR sat unused too
          // long". Surface the distinction so the UI can word the
          // recovery action correctly.
          const code = err?.response?.data?.code === 'SESSION_ALREADY_CONSUMED'
            ? 'SESSION_ALREADY_CONSUMED'
            : 'SESSION_EXPIRED';
          useDeviceStore.getState().setNewDeviceError(code);
          this.rejectPayloadWaiter(sessionId, new Error(code));
          return;
        }
        logger.warn('[DeviceService] linkSessionResult poll error:', err?.message ?? err);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (res.status === 'expired') {
        useDeviceStore.getState().setNewDeviceError('SESSION_EXPIRED');
        this.rejectPayloadWaiter(sessionId, new Error('SESSION_EXPIRED'));
        return;
      }
      if (
        !pubkeySharedHandled &&
        (res.status === 'pubkey-shared' || res.status === 'completed') &&
        res.primaryEphemeralPublicKey &&
        res.primaryUserId &&
        res.identityKeyPub
      ) {
        // Wire v2.1: surface the SN as soon as P_pub is available. We do
        // this from both `pubkey-shared` and `completed` so a client that
        // missed the intermediate poll (slow start, race with backend
        // flipping straight through) still computes the SN before
        // installing.
        await this.onPubkeyShared(res);
        pubkeySharedHandled = true;
      }
      if (
        res.status === 'completed' &&
        res.encryptedPayload &&
        res.primaryEphemeralPublicKey &&
        res.assignedDeviceId !== undefined
      ) {
        await this.onCompletedReady(res);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    } finally {
      // M3: drop the abort flag for this session — without this the Map
      // would accumulate `false` entries (one per pairing attempt) for
      // the lifetime of the app, and a re-entry into the screen with the
      // same sessionId (rare but possible after a hot reload) would
      // observe a stale value.
      this.pollAborted.delete(sessionId);
    }
  }

  /**
   * Backend flipped the session to `pubkey-shared`: we have `P_pub`,
   * `primaryUserId`, and the primary's published `identityKeyPub`. We
   * store these (the identityKeyPub is held for the anti-tamper check at
   * `completed`), compute the SN, and move to `safetyCheck`.
   */
  private async onPubkeyShared(res: LinkSessionResultResponse): Promise<void> {
    const store = useDeviceStore.getState();
    const pairing = store.pairingNewDevice;
    if (
      !pairing ||
      !res.primaryEphemeralPublicKey ||
      !res.primaryUserId ||
      !res.identityKeyPub ||
      !pairing.newDeviceEphemeralPub
    ) return;

    store.setNewDevicePubkeyShared({
      primaryEphemeralPublicKey: res.primaryEphemeralPublicKey,
      primaryUserId: res.primaryUserId,
      identityKeyPub: res.identityKeyPub,
    });

    try {
      // Spec requires `to_canonical(...)` on each pub key — 32B raw. Strip
      // libsignal's DJB framing where present so the SN matches the one
      // computed by the primary.
      const { safetyNumber } = await SignalProtocol.getPairingSafetyNumber(
        stripDjbPrefixB64(pairing.newDeviceEphemeralPub),
        stripDjbPrefixB64(res.primaryEphemeralPublicKey),
        stripDjbPrefixB64(res.identityKeyPub),
        res.primaryUserId,
      );
      store.setNewDeviceSafetyNumber(safetyNumber);
      logger.info('[DeviceService] new-device safety number computed (pubkey-shared)');
    } catch (err: any) {
      logger.error('[DeviceService] onPubkeyShared failed:', err?.message ?? err);
      store.setNewDeviceError('PEEK_FAILED');
    }
  }

  /**
   * Backend flipped the session to `completed`. Decrypt + integrity-check
   * the payload (`peek`), then run the anti-tamper check: the
   * `identityKeyPub` peeked from the decrypted payload MUST match the
   * one received from the server in `pubkey-shared` — a mismatch
   * indicates the server has tampered between the two steps and is the
   * security-relevant abort condition for wire v2.1.
   *
   * If the user has already tapped Match (`safetyConfirmed`), notify any
   * waiter so `confirmNewDeviceSafetyAndInstall` can proceed with
   * `consumeProvisioningPayload`. Otherwise we just stash the payload
   * and let the UI drive the install on Match.
   */
  private async onCompletedReady(res: LinkSessionResultResponse): Promise<void> {
    const store = useDeviceStore.getState();
    const pairing = store.pairingNewDevice;
    if (
      !pairing ||
      !res.encryptedPayload ||
      !res.primaryEphemeralPublicKey ||
      res.assignedDeviceId === undefined ||
      !pairing.newDeviceEphemeralPub ||
      !pairing.newDeviceEphemeralPriv
    ) return;

    store.setNewDeviceResult({
      primaryEphemeralPublicKey: res.primaryEphemeralPublicKey,
      encryptedPayload: res.encryptedPayload,
      assignedDeviceId: res.assignedDeviceId,
    });

    try {
      const peek = await SignalProtocol.peekProvisioningPayload(
        res.encryptedPayload,
        pairing.newDeviceEphemeralPriv,
        res.primaryEphemeralPublicKey,
      );

      // Anti-tamper (wire v2.1): the identityKeyPub the server fed us in
      // `pubkey-shared` MUST be present AND equal to the one inside the
      // just-decrypted payload. The wire v2.1 guarantee is "MITM detected
      // pre-commit"; silently accepting `null` from a server that skipped
      // the share step would downgrade us to "trust whatever the payload
      // says", which is exactly what the share step exists to prevent.
      // So either branch is a hard abort, with a distinct error code so
      // the UI can tell missing infrastructure (PUBKEY_SHARED_MISSING)
      // from active tampering (IDENTITY_KEY_TAMPERED).
      if (
        !pairing.identityKeyPubFromShare ||
        pairing.identityKeyPubFromShare !== peek.identityKeyPub
      ) {
        const reason = pairing.identityKeyPubFromShare
          ? 'IDENTITY_KEY_TAMPERED'
          : 'PUBKEY_SHARED_MISSING';
        logger.error(
          `[DeviceService] anti-tamper abort: ${reason} (have share=${!!pairing.identityKeyPubFromShare})`,
        );
        store.setNewDeviceError(reason);
        this.rejectPayloadWaiter(pairing.sessionId, new Error(reason));
        return;
      }

      store.setNewDevicePeek({
        primaryUserId: peek.primaryUserId,
        identityKeyPub: peek.identityKeyPub,
        primaryName: peek.primaryName ?? null,
      });

      // Recompute SN if we never went through pubkey-shared (edge case:
      // the backend implementation flipped straight to `completed`
      // without an intermediate state, or our first poll missed the
      // intermediate window). Otherwise the SN computed at
      // `onPubkeyShared` is still valid (same inputs).
      if (!pairing.safetyNumber) {
        const { safetyNumber } = await SignalProtocol.getPairingSafetyNumber(
          stripDjbPrefixB64(pairing.newDeviceEphemeralPub),
          stripDjbPrefixB64(res.primaryEphemeralPublicKey),
          stripDjbPrefixB64(peek.identityKeyPub),
          peek.primaryUserId,
        );
        store.setNewDeviceSafetyNumber(safetyNumber);
        logger.info('[DeviceService] new-device safety number computed (completed)');
      }

      // Signal any install-waiter blocked in confirmNewDeviceSafetyAndInstall.
      if (pairing.sessionId) {
        const waiter = this.payloadArrivalResolvers.get(pairing.sessionId);
        if (waiter) {
          this.payloadArrivalResolvers.delete(pairing.sessionId);
          waiter.resolve();
        }
      }
    } catch (err: any) {
      logger.error('[DeviceService] onCompletedReady failed:', err?.message ?? err);
      store.setNewDeviceError('PEEK_FAILED');
      // Unblock any waiter so the UI promise doesn't hang.
      this.rejectPayloadWaiter(
        pairing.sessionId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * User confirmed the safety number on the new device. In wire v2.1
   * this may run BEFORE the encrypted payload has arrived (the SN is
   * surfaced at `pubkey-shared`, the payload only at `completed`); if
   * so, we register a waiter on `payloadArrivalResolvers` and let the
   * still-active poll loop fulfill it from `onCompletedReady`.
   *
   * Once the payload is available we run `consumeProvisioningPayload`
   * to install the identity into the Keychain. The caller (UI) is
   * responsible for the authentication round-trip AFTER this returns
   * — see the login screen for the standard "publish + challenge +
   * authenticate" sequence.
   */
  async confirmNewDeviceSafetyAndInstall(
    deviceName: string,
  ): Promise<{ assignedDeviceId: number }> {
    const store = useDeviceStore.getState();
    let pairing = store.pairingNewDevice;
    if (!pairing || pairing.phase !== 'safetyCheck') {
      throw new Error('confirmNewDeviceSafetyAndInstall called in invalid phase');
    }
    if (!pairing.sessionId || !pairing.newDeviceEphemeralPriv) {
      throw new Error('confirmNewDeviceSafetyAndInstall: missing pairing material');
    }

    // Record that the user confirmed — the UI will switch its messaging
    // (e.g. "Installazione…" instead of the SN screen) on this signal.
    store.setNewDeviceSafetyConfirmed();

    // Wait for the encrypted payload if /complete hasn't fired yet. The
    // poll loop will trigger the resolver via `onCompletedReady`.
    if (!pairing.encryptedPayload) {
      logger.info(
        '[DeviceService] safetyConfirmed but payload not yet arrived — awaiting /complete',
      );
      await new Promise<void>((resolve, reject) => {
        this.payloadArrivalResolvers.set(pairing!.sessionId!, { resolve, reject });
      });
      pairing = useDeviceStore.getState().pairingNewDevice;
      if (!pairing) {
        throw new Error('pairing cleared while awaiting payload');
      }
    }

    if (
      !pairing.encryptedPayload ||
      !pairing.primaryEphemeralPub ||
      !pairing.newDeviceEphemeralPriv ||
      pairing.assignedDeviceId === null
    ) {
      throw new Error('confirmNewDeviceSafetyAndInstall: missing pairing material after wait');
    }

    store.setNewDevicePhase('installing');
    try {
      const bundle = await SignalProtocol.consumeProvisioningPayload(
        pairing.encryptedPayload,
        pairing.newDeviceEphemeralPriv,
        pairing.primaryEphemeralPub,
        pairing.assignedDeviceId,
        deviceName,
      );
      logger.info('[DeviceService] identity installed, deviceId:', bundle.deviceId);

      // Defense-in-depth: the deviceId on the freshly-installed bundle MUST
      // match the one assigned by the server. We pass it INTO the native
      // call, so under normal conditions this is a tautology — but if the
      // native module ever ignores the parameter (regression) or the chain
      // is tampered with (we passed X, native installed Y), authenticating
      // later as the "wrong" deviceId would leave us in a state where the
      // server thinks one device is online but the keypair is bound to a
      // different slot. Wipe the just-installed identity and refuse to
      // proceed so the user gets a clean re-pair attempt.
      if (Number(bundle.deviceId) !== pairing.assignedDeviceId) {
        logger.error(
          '[DeviceService] assignedDeviceId mismatch — wiping freshly installed identity:',
          { server: pairing.assignedDeviceId, native: bundle.deviceId },
        );
        // The wrong-slot identity is already committed to protected storage;
        // it MUST be wiped, otherwise a later `loadStoredLocalUser` would
        // resurrect it. Retry a few times before giving up — a swallowed
        // failure here would defeat the whole point of this guard.
        let wiped = false;
        for (let attempt = 1; attempt <= 3 && !wiped; attempt++) {
          try {
            await SignalProtocol.clearIdentity();
            wiped = true;
          } catch (wipeErr: any) {
            logger.warn(
              `[DeviceService] clearIdentity after mismatch failed (attempt ${attempt}/3):`,
              wipeErr?.message ?? wipeErr,
            );
            if (attempt < 3) await sleep(150);
          }
        }
        if (!wiped) {
          // The mismatched identity is still on the device. Do NOT surface the
          // reassuring ASSIGNED_DEVICE_ID_MISMATCH code (its message says
          // "identity wiped, try again") — escalate to a distinct fatal state
          // so the UI can tell the user to reinstall / clear app data before
          // re-pairing, instead of silently re-using the corrupt identity.
          logger.error(
            '[DeviceService] CRITICAL: could not wipe mismatched identity — manual reinstall required',
          );
          store.setNewDeviceError('IDENTITY_WIPE_FAILED');
          throw new Error('IDENTITY_WIPE_FAILED');
        }
        store.setNewDeviceError('ASSIGNED_DEVICE_ID_MISMATCH');
        throw new Error('ASSIGNED_DEVICE_ID_MISMATCH');
      }

      // The store moves to `done` only after the caller finishes the
      // server-side publish + authenticate flow. We do not flip the phase
      // here because the UI still needs to drive auth before the user can
      // navigate into the app.
      return { assignedDeviceId: pairing.assignedDeviceId };
    } catch (err: any) {
      logger.error('[DeviceService] confirmNewDeviceSafetyAndInstall failed:', err?.message ?? err);
      // Don't overwrite a more specific error code we already set above
      // (e.g. ASSIGNED_DEVICE_ID_MISMATCH).
      if (useDeviceStore.getState().pairingNewDevice?.phase !== 'error') {
        store.setNewDeviceError('INSTALL_FAILED');
      }
      throw err;
    }
  }

  /**
   * User pressed "Don't match" or backed out on the new device. Stops
   * polling and (if we're past safetyCheck) tells the server to
   * invalidate the pending device record via `DELETE /auth/devices/me`
   * — so the primary's complete won't leave orphaned state behind.
   *
   * Best-effort: even if the rollback request fails, we still clear
   * local state and surface the cancel to the UI.
   */
  async cancelNewDeviceLink(): Promise<void> {
    const pairing = useDeviceStore.getState().pairingNewDevice;
    if (pairing?.sessionId) {
      this.pollAborted.set(pairing.sessionId, true);
      // Release any in-flight `confirmNewDeviceSafetyAndInstall` waiter
      // so the UI's install promise rejects cleanly on user abort.
      this.rejectPayloadWaiter(pairing.sessionId, new Error('CANCELLED'));
    }
    // Best-effort server-side rollback: only meaningful once /complete
    // has assigned a deviceId. In wire v2.1 the user can press
    // "Don't match" while still at `safetyCheck` before the primary
    // commits — no device row exists yet, nothing to revoke.
    if (
      (pairing?.phase === 'safetyCheck' || pairing?.phase === 'installing') &&
      pairing?.assignedDeviceId !== null &&
      pairing?.assignedDeviceId !== undefined
    ) {
      try {
        const api = getDefaultApi();
        await api.revokeMyDevice();
      } catch (err: any) {
        logger.warn('[DeviceService] rollback revokeMyDevice failed (non-fatal):', err?.message ?? err);
      }
    }
    useDeviceStore.getState().clearNewDevicePairing();
  }

  // ===================== DEVICE LIST + REVOCATION =====================

  /** Fetch the device list from the server and populate the store. */
  async loadDevices(): Promise<DeviceInfo[]> {
    const store = useDeviceStore.getState();
    store.setLoadingDevices(true);
    try {
      const api = getDefaultApi();
      const res = await api.listDevices();
      store.setDevices(res.devices);
      return res.devices;
    } catch (err: any) {
      logger.warn('[DeviceService] loadDevices failed:', err?.message ?? err);
      throw err;
    } finally {
      store.setLoadingDevices(false);
    }
  }

  /**
   * Primary revokes a linked device. The server emits `deviceRevoked`
   * socket events to peers and (if online) the revoked device itself —
   * those are handled by the socket-level listener in chat/app-init,
   * not here.
   */
  async revokeDevice(deviceId: number): Promise<void> {
    const api = getDefaultApi();
    await api.revokeDevice(deviceId);
    useDeviceStore.getState().removeDevice(deviceId);

    // M10: drop the libsignal session for our own linked device that we
    // just revoked. Without this, the self-fanout loop in chat.encrypt
    // would keep encrypting for a deviceId the server has cut off, until
    // the next /keys/:userId refresh updates the cache. Symmetric with
    // the peer-revoke handler in chat.service.onDeviceRevoked which
    // already drops the libsignal session for revoked peer devices.
    try {
      const tokenPayload = await api.getTokenPayload();
      const ownUserId = String(tokenPayload?.sub ?? '');
      if (ownUserId) {
        await SignalProtocol.deleteRemoteSession(ownUserId, deviceId);
        logger.info(`[DeviceService] revokeDevice: dropped native session for self/${deviceId}`);
      }
    } catch (err: any) {
      logger.warn(
        '[DeviceService] revokeDevice: deleteRemoteSession failed (non-fatal):',
        err?.message ?? err,
      );
    }
  }
}

// ===================== HELPERS =====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map an HTTP status returned by `POST /auth/devices/link/share-pubkey`
 * to a phase-machine error code. 409 collapses to PUBKEY_MISMATCH or
 * SESSION_NOT_WAITING depending on the body code; if the backend does
 * not surface a code, default to PUBKEY_MISMATCH (the more security-
 * relevant of the two — a session in the wrong state usually means a
 * concurrent re-attempt or stale session, while a mismatch is the
 * potential MITM signal we want to alert on).
 */
function mapSharePubkeyError(status: number | undefined): string {
  if (status === 404) return 'SESSION_NOT_FOUND';
  if (status === 410) return 'SESSION_EXPIRED';
  if (status === 409) return 'PUBKEY_MISMATCH';
  return 'SHARE_PUBKEY_FAILED';
}

export const deviceService = new DeviceService();
