import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { DeviceInfo } from '@/types/device';

/**
 * Multi-device pairing state — Zustand store (wire v2).
 *
 * Two flows live here: the **primary side** (existing authenticated device
 * scanning a QR from a new device) and the **new-device side** (fresh
 * device showing a QR and waiting for the primary to complete the link).
 * They never run in parallel on the same instance — at most one of
 * `pairingPrimary` / `pairingNewDevice` is non-null at a time.
 *
 * Phases (wire v2.1 — see ADR-0003 + ADR-0004):
 *
 * - PRIMARY:    idle → scanning → safetyCheck → completing → done | error
 * - NEW DEVICE: idle → init     → waiting     → polling    → safetyCheck → installing → done | error
 *
 * The phase string set is unchanged from v2 — the v2.1 share-pubkey step
 * is a side-effect inside the existing `scanning → safetyCheck` transition
 * on the primary, and a new branch inside `polling` on the new device.
 *
 * Primary side (wire v2.1): `handlePrimaryScannedQR` now does
 *   QR scan → generate P_pub → compute SN → POST /link/share-pubkey
 *   → transition to safetyCheck (only after share-pubkey ack).
 * New-device side (wire v2.1): `pollNewDeviceSessionResult` now branches
 * on /result `status`:
 *   - `pubkey-shared` → store P_pub + identityKeyPub from server, compute
 *     SN, transition to safetyCheck. Keep polling.
 *   - `completed` → verify identityKeyPub from decrypted payload matches
 *     the one received in `pubkey-shared` (anti-tamper). If the user has
 *     already tapped Match (`safetyConfirmed === true`), install
 *     immediately; otherwise hold the encrypted payload until they do.
 *
 * The store does NOT call the native module or the API directly. Side
 * effects live in `device.service.ts`; the store is only state + actions.
 */

export type PrimaryPhase =
  | 'idle'
  | 'scanning'
  | 'safetyCheck'
  | 'completing'
  | 'done'
  | 'error';

export type NewDevicePhase =
  | 'idle'
  | 'init'
  | 'waiting'
  | 'polling'
  | 'safetyCheck'
  | 'installing'
  | 'done'
  | 'error';

export interface PairingPrimaryState {
  phase: PrimaryPhase;
  // Session metadata extracted from the scanned QR.
  sessionId: string | null;
  serverOrigin: string | null;
  // New device's ephemeral pub — comes in-band from the QR (v2).
  newDeviceEphemeralPub: string | null;
  // Primary's per-pairing ephemeral keypair. Held in memory only — never
  // persisted. Discarded when the pairing flow exits.
  primaryEphemeralPub: string | null;
  primaryEphemeralPriv: string | null;
  // Safety number presented to the user for out-of-band verification.
  safetyNumber: string | null;
  // Result of POST /auth/devices/link/complete.
  assignedDeviceId: number | null;
  errorMessage: string | null;
}

export interface PairingNewDeviceState {
  phase: NewDevicePhase;
  // Session id — assigned by the server in POST /link/init.
  sessionId: string | null;
  serverOrigin: string | null;
  // The provisioning URL we render as QR. Built locally after `linkInit`.
  provisioningUrl: string | null;
  expiresAt: string | null;
  // New device's per-pairing ephemeral keypair.
  newDeviceEphemeralPub: string | null;
  newDeviceEphemeralPriv: string | null;
  // Surfaced by GET /link/session/:id/result. In wire v2.1, P_pub arrives
  // at the `pubkey-shared` intermediate status (before /complete);
  // encryptedPayload + assignedDeviceId arrive at `completed`.
  primaryEphemeralPub: string | null;
  encryptedPayload: string | null;
  assignedDeviceId: number | null;
  // Identity public key for the primary, served via /result lookup at the
  // `pubkey-shared` step (wire v2.1). Used both as input to the safety
  // number AND for the anti-tamper check at /result `completed`: the
  // identityKeyPub from the decrypted payload MUST equal this value,
  // otherwise the server has tampered with one of them between steps.
  identityKeyPubFromShare: string | null;
  // Peeked from the encrypted payload (without installing the identity yet).
  peekedPrimaryUserId: string | null;
  peekedIdentityKeyPub: string | null;
  peekedPrimaryName: string | null;
  // Safety number presented to the user for out-of-band verification.
  safetyNumber: string | null;
  // True once the user has tapped "Match" on the safety number. Used to
  // coordinate the install: with wire v2.1 the user may confirm BEFORE
  // the encrypted payload has arrived (since SN is shown at
  // `pubkey-shared`); we then auto-install as soon as /result reports
  // `completed`. If the payload arrived first, install runs immediately
  // on tap Match.
  safetyConfirmed: boolean;
  errorMessage: string | null;
}

interface DeviceState {
  devices: DeviceInfo[];
  loadingDevices: boolean;
  devicesLastFetchedAt: number | null;

  pairingPrimary: PairingPrimaryState | null;
  pairingNewDevice: PairingNewDeviceState | null;

  // ===== devices list =====
  setDevices: (devices: DeviceInfo[]) => void;
  setLoadingDevices: (loading: boolean) => void;
  upsertDevice: (device: DeviceInfo) => void;
  removeDevice: (deviceId: number) => void;

  // ===== primary pairing (scanner side) =====
  startPrimaryScan: () => void;
  setPrimaryPhase: (phase: PrimaryPhase) => void;
  setPrimaryScannedQR: (params: {
    sessionId: string;
    serverOrigin: string;
    newDeviceEphemeralPub: string;
  }) => void;
  setPrimaryEphemeral: (publicKey: string, privateKey: string) => void;
  setPrimarySafetyNumber: (safetyNumber: string) => void;
  setPrimaryAssignedDeviceId: (deviceId: number) => void;
  setPrimaryError: (message: string) => void;
  clearPrimaryPairing: () => void;

  // ===== new-device pairing (show-QR side) =====
  startNewDeviceLink: (serverOrigin: string) => void;
  setNewDevicePhase: (phase: NewDevicePhase) => void;
  setNewDeviceEphemeral: (publicKey: string, privateKey: string) => void;
  setNewDeviceSession: (params: {
    sessionId: string;
    expiresAt: string;
    provisioningUrl: string;
  }) => void;
  setNewDeviceResult: (params: {
    primaryEphemeralPublicKey: string;
    encryptedPayload: string;
    assignedDeviceId: number;
  }) => void;
  // Wire v2.1: called when /result returns `pubkey-shared` (before complete).
  // Stores the intermediate material so the SN can be computed immediately
  // and held for the anti-tamper check later.
  setNewDevicePubkeyShared: (params: {
    primaryEphemeralPublicKey: string;
    primaryUserId: string;
    identityKeyPub: string;
  }) => void;
  setNewDevicePeek: (params: {
    primaryUserId: string;
    identityKeyPub: string;
    primaryName?: string | null;
  }) => void;
  setNewDeviceSafetyNumber: (safetyNumber: string) => void;
  setNewDeviceSafetyConfirmed: () => void;
  setNewDeviceError: (message: string) => void;
  clearNewDevicePairing: () => void;
}

const emptyPrimary = (): PairingPrimaryState => ({
  phase: 'idle',
  sessionId: null,
  serverOrigin: null,
  newDeviceEphemeralPub: null,
  primaryEphemeralPub: null,
  primaryEphemeralPriv: null,
  safetyNumber: null,
  assignedDeviceId: null,
  errorMessage: null,
});

const emptyNewDevice = (): PairingNewDeviceState => ({
  phase: 'idle',
  sessionId: null,
  serverOrigin: null,
  provisioningUrl: null,
  expiresAt: null,
  newDeviceEphemeralPub: null,
  newDeviceEphemeralPriv: null,
  primaryEphemeralPub: null,
  encryptedPayload: null,
  assignedDeviceId: null,
  identityKeyPubFromShare: null,
  peekedPrimaryUserId: null,
  peekedIdentityKeyPub: null,
  peekedPrimaryName: null,
  safetyNumber: null,
  safetyConfirmed: false,
  errorMessage: null,
});

export const useDeviceStore = create<DeviceState>()(
  immer((set) => ({
    devices: [],
    loadingDevices: false,
    devicesLastFetchedAt: null,
    pairingPrimary: null,
    pairingNewDevice: null,

    setDevices: (devices) =>
      set((state) => {
        state.devices = devices;
        state.devicesLastFetchedAt = Date.now();
      }),

    setLoadingDevices: (loading) =>
      set((state) => {
        state.loadingDevices = loading;
      }),

    upsertDevice: (device) =>
      set((state) => {
        const idx = state.devices.findIndex((d) => d.deviceId === device.deviceId);
        if (idx >= 0) state.devices[idx] = device;
        else state.devices.push(device);
      }),

    removeDevice: (deviceId) =>
      set((state) => {
        state.devices = state.devices.filter((d) => d.deviceId !== deviceId);
      }),

    // ===== primary pairing (scanner side) =====

    startPrimaryScan: () =>
      set((state) => {
        state.pairingPrimary = { ...emptyPrimary(), phase: 'scanning' };
      }),

    setPrimaryPhase: (phase) =>
      set((state) => {
        if (state.pairingPrimary) state.pairingPrimary.phase = phase;
      }),

    setPrimaryScannedQR: ({ sessionId, serverOrigin, newDeviceEphemeralPub }) =>
      set((state) => {
        if (!state.pairingPrimary) state.pairingPrimary = emptyPrimary();
        state.pairingPrimary.sessionId = sessionId;
        state.pairingPrimary.serverOrigin = serverOrigin;
        state.pairingPrimary.newDeviceEphemeralPub = newDeviceEphemeralPub;
        // Stay in `scanning` until the safety number is computed.
      }),

    setPrimaryEphemeral: (publicKey, privateKey) =>
      set((state) => {
        if (!state.pairingPrimary) state.pairingPrimary = emptyPrimary();
        state.pairingPrimary.primaryEphemeralPub = publicKey;
        state.pairingPrimary.primaryEphemeralPriv = privateKey;
      }),

    setPrimarySafetyNumber: (safetyNumber) =>
      set((state) => {
        if (!state.pairingPrimary) state.pairingPrimary = emptyPrimary();
        state.pairingPrimary.safetyNumber = safetyNumber;
        state.pairingPrimary.phase = 'safetyCheck';
      }),

    setPrimaryAssignedDeviceId: (deviceId) =>
      set((state) => {
        if (state.pairingPrimary) {
          state.pairingPrimary.assignedDeviceId = deviceId;
          state.pairingPrimary.phase = 'done';
        }
      }),

    setPrimaryError: (message) =>
      set((state) => {
        if (!state.pairingPrimary) state.pairingPrimary = emptyPrimary();
        state.pairingPrimary.errorMessage = message;
        state.pairingPrimary.phase = 'error';
      }),

    clearPrimaryPairing: () =>
      set((state) => {
        state.pairingPrimary = null;
      }),

    // ===== new-device pairing (show-QR side) =====

    startNewDeviceLink: (serverOrigin) =>
      set((state) => {
        state.pairingNewDevice = {
          ...emptyNewDevice(),
          phase: 'init',
          serverOrigin,
        };
      }),

    setNewDevicePhase: (phase) =>
      set((state) => {
        if (state.pairingNewDevice) state.pairingNewDevice.phase = phase;
      }),

    setNewDeviceEphemeral: (publicKey, privateKey) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.newDeviceEphemeralPub = publicKey;
        state.pairingNewDevice.newDeviceEphemeralPriv = privateKey;
      }),

    setNewDeviceSession: ({ sessionId, expiresAt, provisioningUrl }) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.sessionId = sessionId;
        state.pairingNewDevice.expiresAt = expiresAt;
        state.pairingNewDevice.provisioningUrl = provisioningUrl;
        state.pairingNewDevice.phase = 'waiting';
      }),

    setNewDeviceResult: ({ primaryEphemeralPublicKey, encryptedPayload, assignedDeviceId }) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.primaryEphemeralPub = primaryEphemeralPublicKey;
        state.pairingNewDevice.encryptedPayload = encryptedPayload;
        state.pairingNewDevice.assignedDeviceId = assignedDeviceId;
      }),

    setNewDevicePubkeyShared: ({ primaryEphemeralPublicKey, primaryUserId, identityKeyPub }) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.primaryEphemeralPub = primaryEphemeralPublicKey;
        state.pairingNewDevice.peekedPrimaryUserId = primaryUserId;
        state.pairingNewDevice.identityKeyPubFromShare = identityKeyPub;
        state.pairingNewDevice.phase = 'safetyCheck';
      }),

    setNewDevicePeek: ({ primaryUserId, identityKeyPub, primaryName }) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.peekedPrimaryUserId = primaryUserId;
        state.pairingNewDevice.peekedIdentityKeyPub = identityKeyPub;
        state.pairingNewDevice.peekedPrimaryName = primaryName ?? null;
        // Phase already in `safetyCheck` from setNewDevicePubkeyShared in
        // wire v2.1; left as-is on the off chance we ever bypass that step.
        if (state.pairingNewDevice.phase !== 'safetyCheck') {
          state.pairingNewDevice.phase = 'safetyCheck';
        }
      }),

    setNewDeviceSafetyNumber: (safetyNumber) =>
      set((state) => {
        if (state.pairingNewDevice) state.pairingNewDevice.safetyNumber = safetyNumber;
      }),

    setNewDeviceSafetyConfirmed: () =>
      set((state) => {
        if (state.pairingNewDevice) state.pairingNewDevice.safetyConfirmed = true;
      }),

    setNewDeviceError: (message) =>
      set((state) => {
        if (!state.pairingNewDevice) state.pairingNewDevice = emptyNewDevice();
        state.pairingNewDevice.errorMessage = message;
        state.pairingNewDevice.phase = 'error';
      }),

    clearNewDevicePairing: () =>
      set((state) => {
        state.pairingNewDevice = null;
      }),
  }))
);
