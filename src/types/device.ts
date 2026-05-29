/**
 * Multi-device linking — types
 *
 * Wire contract: `_shared/api/multi-device-linking.md` (status: Accepted,
 * v2; v2.1 proposed extension with `/link/share-pubkey` and `pubkey-shared`
 * intermediate session state — ADR-0004).
 * Architecture: `_shared/decisions/0001-multi-device-architecture.md` (ADR-0001).
 * Direction: `_shared/decisions/0003-pairing-direction-flip.md` (ADR-0003).
 * Symmetric SN: `_shared/decisions/0004-symmetric-safety-number.md` (ADR-0004).
 */

export type DeviceStatus = 'active' | 'pending_link' | 'revoked';

export interface DeviceInfo {
  deviceId: number;
  deviceName: string;
  status: DeviceStatus;
  isPrimary: boolean;
  isCurrent: boolean;
  createdAt: string;        // ISO 8601
  lastSeen: string | null;  // ISO 8601, precision 1 min
  userAgent: string | null;
}

/**
 * New-device-side request to `POST /auth/devices/link/init`. Anonymous.
 */
export interface LinkInitRequest {
  ephemeralPublicKey: string;   // base64, new device's ephemeral X25519 pub
  deviceName?: string;
  userAgent?: string;
}

export interface LinkInitResponse {
  sessionId: string;   // base64url(32B), 43 chars, no padding
  expiresAt: string;   // ISO 8601, +5min from creation
}

/**
 * Primary-side request to `POST /auth/devices/link/share-pubkey` (wire v2.1).
 * Deposits `P_pub` on the session WITHOUT committing the identity transfer,
 * so the new device can compute its own safety number before the primary
 * calls `/complete`. Idempotent for same `P_pub`; backend returns 409
 * `PUBKEY_MISMATCH` on different `P_pub` and 409 `SESSION_NOT_WAITING` if
 * the session is not in `waiting`.
 */
export interface LinkSharePubkeyRequest {
  sessionId: string;
  primaryEphemeralPublicKey: string; // base64 (raw 32B, no DJB prefix)
}

export interface LinkSharePubkeyResponse {
  ok: true;
}

/**
 * Primary-side request to `POST /auth/devices/link/complete` (wire v2.1).
 *
 * Note: `primaryEphemeralPublicKey` is intentionally absent — the server
 * already received it via `/link/share-pubkey` (which must run before
 * /complete in wire v2.1). The session must be in `pubkey-shared` state.
 */
export interface LinkCompleteRequest {
  sessionId: string;
  encryptedPayload: string; // base64 of provisioning ciphertext
}

export interface LinkCompleteResponse {
  assignedDeviceId: number;
  expiresAt: string;
}

/**
 * New-device-side polling response from
 * `GET /auth/devices/link/session/:sessionId/result`.
 *
 * Wire v2.1 introduces the intermediate `pubkey-shared` status: once the
 * primary calls `/share-pubkey`, the server flips the session to
 * `pubkey-shared` and starts returning `primaryEphemeralPublicKey`,
 * `primaryUserId`, and `identityKeyPub` (looked up from the primary's
 * published bundle). The new device uses these to compute its own SN
 * BEFORE the primary calls `/complete`. The same three fields are
 * returned in `completed` for convenience on the first poll after the
 * commit (so a client that joined the session late doesn't need a
 * separate fetch). At `completed`, the client must verify that
 * `identityKeyPub` from `/result` matches the `identityKeyPub` it later
 * decrypts from the provisioning payload — mismatch indicates a server
 * tampering between share-pubkey and complete.
 */
export interface LinkSessionResultResponse {
  status: 'pending' | 'pubkey-shared' | 'completed' | 'expired';
  // Set from `pubkey-shared` onward.
  primaryEphemeralPublicKey?: string;
  primaryUserId?: string;
  identityKeyPub?: string; // primary's published identity public key
  // Set only at `completed`.
  assignedDeviceId?: number;
  encryptedPayload?: string;
}

export interface DeviceListResponse {
  devices: DeviceInfo[];
}

export interface DeviceRevokeResponse {
  deviceId: number;
  status: 'revoked';
  revokedAt: string;
}

/**
 * Provisioning payload v1 — JSON shape carried inside the AES-256-GCM
 * ciphertext. The client never assembles or parses this directly: it is
 * produced internally by `SignalProtocol.encryptProvisioningPayload` and
 * consumed by `SignalProtocol.consumeProvisioningPayload`. Defined here
 * only for documentation and unit tests of the native bridge.
 *
 * Note: the payload version stays at `v: 1` even in wire v2 — only the
 * external orchestration changed, not the payload format itself.
 */
export interface ProvisioningPayloadV1 {
  v: 1;
  identityKeySerialized: string;
  identityKeyPub: string;
  primaryUserId: string;
  primaryName?: string;
}

/**
 * Parsed deep link
 *   `tillit://link?v=2&i=<sessionId>&s=<base64url(server_origin)>&e=<base64url(E_pub)>`
 *
 * All fields are required:
 * - `v` must be `2`
 * - `sessionId` (`i`) identifies the session created by the new device
 * - `serverOrigin` (`s`) lets the primary verify it targets its own server
 * - `newDeviceEphemeralPub` (`e`) is the E_pub used for ECDH+HKDF — it
 *   travels in-band in the QR so the server can never substitute it
 */
export interface ProvisioningLinkParams {
  v: 2;
  sessionId: string;
  serverOrigin: string;
  newDeviceEphemeralPub: string;
}
