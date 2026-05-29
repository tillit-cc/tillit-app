import { SignalProtocol } from 'signal-protocol';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  __resetProvisioningMock,
  MOCK_PRIMARY_IDENTITY_PUB,
} = require('../../__mocks__/signal-protocol');

// These tests exercise the JS wrapper surface and the mock round-trip semantics
// for the multi-device provisioning helpers added in ADR-0001. The native
// implementations on iOS/Android are tested separately at build time (XCTest /
// Espresso) — here we only validate the contract is wired correctly and the
// API is callable from the JS layer with the expected shapes.
//
// Additionally we cover the `parseProvisioningLink` wire-v2 parser added in
// ADR-0003 (pairing direction flip), where the QR now carries E_pub in-band.
//
// Spec: _shared/api/multi-device-linking.md (v2)
// ADR : _shared/decisions/0001-multi-device-architecture.md
//       _shared/decisions/0003-pairing-direction-flip.md

describe('multi-device provisioning helpers', () => {
  beforeEach(() => {
    __resetProvisioningMock();
  });

  describe('generateProvisioningKeypair', () => {
    it('returns a fresh base64 keypair on each call', async () => {
      const a = await SignalProtocol.generateProvisioningKeypair();
      const b = await SignalProtocol.generateProvisioningKeypair();
      expect(a.publicKey).toEqual(expect.stringMatching(/=$/));
      expect(a.privateKey).toEqual(expect.stringMatching(/=$/));
      expect(a.publicKey).not.toEqual(b.publicKey);
      expect(a.privateKey).not.toEqual(b.privateKey);
    });
  });

  describe('encryptProvisioning / decryptProvisioning round-trip', () => {
    it('primary → new device payload survives the round-trip', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const plaintext = Buffer.from(JSON.stringify({
        v: 1,
        identityKeySerialized: 'AAAAidentityBlobBase64==',
        identityKeyPub: 'AAAAidentityPubBase64==',
        primaryUserId: 'user-uuid-1234',
        primaryName: 'Marco',
      })).toString('base64');

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        plaintext,
        newDevice.publicKey,
        primary.privateKey,
      );

      const { plaintext: recovered } = await SignalProtocol.decryptProvisioning(
        ciphertext,
        newDevice.privateKey,
        primary.publicKey,
      );

      expect(recovered).toEqual(plaintext);
    });

    it('decrypt fails with the wrong recipient private key (AEAD tag mismatch)', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const stranger = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        Buffer.from('secret').toString('base64'),
        newDevice.publicKey,
        primary.privateKey,
      );

      await expect(
        SignalProtocol.decryptProvisioning(ciphertext, stranger.privateKey, primary.publicKey),
      ).rejects.toThrow();
    });

    it('decrypt fails when the sender public key does not match the one used to encrypt', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();
      const imposter = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        Buffer.from('secret').toString('base64'),
        newDevice.publicKey,
        primary.privateKey,
      );

      await expect(
        SignalProtocol.decryptProvisioning(ciphertext, newDevice.privateKey, imposter.publicKey),
      ).rejects.toThrow();
    });
  });

  describe('getPairingSafetyNumber', () => {
    const E_PUB = 'AAAAephemeralA==';
    const P_PUB = 'AAAAephemeralB==';
    const ID_PUB = 'AAAAidentityPub==';
    const USER_ID = 'user-uuid-1234';

    it('is deterministic for the same inputs', async () => {
      const a = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, USER_ID);
      const b = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, USER_ID);
      expect(a.safetyNumber).toEqual(b.safetyNumber);
    });

    it('returns 60 digits in 12 space-separated groups of 5', async () => {
      const { safetyNumber } = await SignalProtocol.getPairingSafetyNumber(
        E_PUB, P_PUB, ID_PUB, USER_ID,
      );
      // 60 digits + 11 spaces = 71 chars
      expect(safetyNumber).toHaveLength(71);
      const groups = safetyNumber.split(' ');
      expect(groups).toHaveLength(12);
      groups.forEach((group) => {
        expect(group).toMatch(/^\d{5}$/);
      });
    });

    it('changes when any input changes', async () => {
      const base = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, USER_ID);
      const changedA = await SignalProtocol.getPairingSafetyNumber('different==', P_PUB, ID_PUB, USER_ID);
      const changedB = await SignalProtocol.getPairingSafetyNumber(E_PUB, 'different==', ID_PUB, USER_ID);
      const changedId = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, 'different==', USER_ID);
      const changedUser = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, 'other-user');

      expect(changedA.safetyNumber).not.toEqual(base.safetyNumber);
      expect(changedB.safetyNumber).not.toEqual(base.safetyNumber);
      expect(changedId.safetyNumber).not.toEqual(base.safetyNumber);
      expect(changedUser.safetyNumber).not.toEqual(base.safetyNumber);
    });

    it('binds the primaryUserId — same ephemeral/identity but different user → different number', async () => {
      const userA = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, 'alice');
      const userB = await SignalProtocol.getPairingSafetyNumber(E_PUB, P_PUB, ID_PUB, 'bob');
      expect(userA.safetyNumber).not.toEqual(userB.safetyNumber);
    });
  });

  describe('initializeIdentity', () => {
    it('accepts the legacy 2-arg call (single-device path)', async () => {
      const bundle = await SignalProtocol.initializeIdentity(1, 'TilliT User');
      expect(bundle.deviceId).toBeDefined();
      expect(bundle.identityPublicKey).toBeDefined();
    });

    it('accepts an existingIdentityKey for the linked-device import path', async () => {
      const bundle = await SignalProtocol.initializeIdentity(2, 'TilliT User', {
        serialized: 'AAAAimportedIdentityBlobBase64==',
      });
      expect(bundle.identityPublicKey).toBeDefined();
    });
  });

  describe('encryptMessage with explicit remoteDeviceId', () => {
    it('accepts the new 3-arg call (fan-out send)', async () => {
      const { encryptedMessage } = await SignalProtocol.encryptMessage('hello', 'peer-id', 2);
      expect(encryptedMessage).toEqual('encrypted:hello');
    });

    it('remains backward-compatible with the 2-arg call', async () => {
      const { encryptedMessage } = await SignalProtocol.encryptMessage('hello', 'peer-id');
      expect(encryptedMessage).toEqual('encrypted:hello');
    });
  });

  describe('deleteRemoteSession', () => {
    it('resolves without error and accepts the optional deviceId', async () => {
      await expect(SignalProtocol.deleteRemoteSession('peer-id')).resolves.toBeUndefined();
      await expect(SignalProtocol.deleteRemoteSession('peer-id', 2)).resolves.toBeUndefined();
    });
  });

  // Option B: the production pairing flow. The identity private key MUST
  // stay confined to native code — the JS surface only sees the ciphertext
  // (primary side) or the public bundle (new device side). The mock
  // simulates this by holding the identity inside the wrapper and only
  // emitting the public bundle at the end of consumeProvisioningPayload.
  describe('encryptProvisioningPayload / consumeProvisioningPayload (Option B)', () => {
    it('end-to-end: primary encrypts payload, new device consumes and gets a public bundle', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
        'Marco',
      );

      // Sanity: the ciphertext is opaque base64. No `identityKeyPriv`
      // substring anywhere accessible to the JS caller.
      expect(ciphertext).toEqual(expect.stringMatching(/^[A-Za-z0-9+/=]+$/));
      expect(ciphertext).not.toContain('identityKeyPriv');

      const bundle = await SignalProtocol.consumeProvisioningPayload(
        ciphertext,
        newDevice.privateKey,
        primary.publicKey,
        2,
        'TilliT User',
      );

      // The bundle is the public material only. The identity public key
      // surfaced to the new device matches the primary's identityKeyPub
      // embedded in the payload (verifiable cross-check).
      expect(bundle.identityPublicKey).toEqual(MOCK_PRIMARY_IDENTITY_PUB);
      expect(bundle.deviceId).toEqual(2);
      expect(bundle.signedPreKey).toBeDefined();
      expect(bundle.preKeys).toHaveLength(100);
      expect(bundle.kyberPreKeys).toHaveLength(100);

      // Critical assertion for Option B: NO private key field anywhere in
      // the JS-visible bundle. The identity private material lives only
      // inside native protected storage.
      const dump = JSON.stringify(bundle);
      expect(dump).not.toMatch(/priv|Priv|PRIVATE|private/);
    });

    it('consume fails when the recipient private key is wrong (AEAD)', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const stranger = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
      );

      await expect(
        SignalProtocol.consumeProvisioningPayload(
          ciphertext,
          stranger.privateKey,
          primary.publicKey,
          2,
          'TilliT User',
        ),
      ).rejects.toThrow();
    });

    it('consume fails when the sender public key is wrong (AEAD)', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();
      const imposter = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
      );

      await expect(
        SignalProtocol.consumeProvisioningPayload(
          ciphertext,
          newDevice.privateKey,
          imposter.publicKey,
          2,
          'TilliT User',
        ),
      ).rejects.toThrow();
    });

    it('consume fails on integrity mismatch (identityKeyPub does not match identityKeySerialized)', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      // Forge a payload by hand using the low-level encryptProvisioning.
      // The serialized blob and pub do NOT follow the naming convention
      // (Serialized↔Pub), so the consume integrity check must reject it.
      const forgedPlaintext = Buffer.from(JSON.stringify({
        v: 1,
        identityKeySerialized: 'forgedSerialized==',
        identityKeyPub: 'AAAtotallyUnrelatedPub==',
        primaryUserId: 'user-uuid-1234',
      })).toString('base64');

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        forgedPlaintext,
        newDevice.publicKey,
        primary.privateKey,
      );

      await expect(
        SignalProtocol.consumeProvisioningPayload(
          ciphertext,
          newDevice.privateKey,
          primary.publicKey,
          2,
          'TilliT User',
        ),
      ).rejects.toThrow(/integrity check/i);
    });

    it('consume fails on unsupported version', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const futureVersion = Buffer.from(JSON.stringify({
        v: 2,
        identityKeySerialized: 'mockIdentityPrimarySerialized==',
        identityKeyPub: 'mockIdentityPrimaryPub==',
        primaryUserId: 'user-uuid-1234',
      })).toString('base64');

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        futureVersion,
        newDevice.publicKey,
        primary.privateKey,
      );

      await expect(
        SignalProtocol.consumeProvisioningPayload(
          ciphertext,
          newDevice.privateKey,
          primary.publicKey,
          2,
          'TilliT User',
        ),
      ).rejects.toThrow(/version/i);
    });

    it('passes the primaryName through when provided', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      // We can't directly inspect the encrypted payload, but we can verify
      // that the call signature accepts both with and without primaryName.
      const withName = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
        'Marco',
      );
      const withoutName = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
      );
      expect(withName.ciphertext).toBeDefined();
      expect(withoutName.ciphertext).toBeDefined();
    });
  });

  // Three-way split of the new-device side: peek (decrypt + integrity check
  // only) → user confirms safety number → consume (commit identity to
  // Keychain + generate per-device keys). The peek path keeps the identity
  // private key inside native code while exposing only the public fields
  // needed to compute the safety number.
  describe('peekProvisioningPayload (pre-install safety check)', () => {
    it('returns primaryUserId and identityKeyPub for a valid payload', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
        'Marco',
      );

      const peek = await SignalProtocol.peekProvisioningPayload(
        ciphertext,
        newDevice.privateKey,
        primary.publicKey,
      );
      expect(peek.primaryUserId).toEqual('user-uuid-1234');
      expect(peek.identityKeyPub).toEqual(MOCK_PRIMARY_IDENTITY_PUB);
      expect(peek.primaryName).toEqual('Marco');

      // Crucial: peek MUST NOT include any private-key field.
      const dump = JSON.stringify(peek);
      expect(dump).not.toMatch(/priv|Priv|PRIVATE|private/);
      expect(dump).not.toMatch(/identityKeySerialized/);
    });

    it('omits primaryName when the primary did not provide one', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
      );

      const peek = await SignalProtocol.peekProvisioningPayload(
        ciphertext,
        newDevice.privateKey,
        primary.publicKey,
      );
      expect(peek.primaryUserId).toEqual('user-uuid-1234');
      expect(peek.primaryName).toBeUndefined();
    });

    it('rejects payloads that fail the integrity check', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      // Forge a payload by hand using the low-level encryptProvisioning.
      const forged = Buffer.from(JSON.stringify({
        v: 1,
        identityKeySerialized: 'forgedSerialized==',
        identityKeyPub: 'AAAtotallyUnrelatedPub==',
        primaryUserId: 'user-uuid-1234',
      })).toString('base64');

      const { ciphertext } = await SignalProtocol.encryptProvisioning(
        forged,
        newDevice.publicKey,
        primary.privateKey,
      );

      await expect(
        SignalProtocol.peekProvisioningPayload(ciphertext, newDevice.privateKey, primary.publicKey),
      ).rejects.toThrow(/integrity check/i);
    });

    it('peek does not install — a subsequent consume still succeeds independently', async () => {
      const newDevice = await SignalProtocol.generateProvisioningKeypair();
      const primary = await SignalProtocol.generateProvisioningKeypair();

      const { ciphertext } = await SignalProtocol.encryptProvisioningPayload(
        newDevice.publicKey,
        primary.privateKey,
        'user-uuid-1234',
      );

      await SignalProtocol.peekProvisioningPayload(ciphertext, newDevice.privateKey, primary.publicKey);
      const bundle = await SignalProtocol.consumeProvisioningPayload(
        ciphertext,
        newDevice.privateKey,
        primary.publicKey,
        2,
        'TilliT User',
      );
      expect(bundle.identityPublicKey).toEqual(MOCK_PRIMARY_IDENTITY_PUB);
      expect(bundle.deviceId).toEqual(2);
    });
  });

  // Wire-v2 QR parser (ADR-0003 — pairing direction flip). The QR now
  // carries E_pub (new device's ephemeral pub) in-band, alongside the
  // sessionId and serverOrigin. The parser must be strict — a malformed
  // QR or one that targets a wrong version must not produce a partial
  // ProvisioningLinkParams.
  describe('parseProvisioningLinkV2 (wire v2)', () => {
    // Pure module — no native chain dependency.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      parseProvisioningLinkV2,
      buildProvisioningUrlV2,
      originsMatch,
    } = require('../services/provisioning-link');

    const VALID_E_PUB_BASE64 = 'A'.repeat(43) + '=';                       // 32 bytes
    const VALID_E_PUB_URL = 'A'.repeat(43);                                // base64url no padding
    const ORIGIN = 'https://api.tillit.cc';
    const ORIGIN_B64URL =
      Buffer.from(ORIGIN, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const SESSION = 'sess_' + 'A'.repeat(38);

    it('parses a well-formed v=2 URL', () => {
      const url = `tillit://link?v=2&i=${SESSION}&s=${ORIGIN_B64URL}&e=${VALID_E_PUB_URL}`;
      const parsed = parseProvisioningLinkV2(url);
      expect(parsed).not.toBeNull();
      expect(parsed.v).toBe(2);
      expect(parsed.sessionId).toBe(SESSION);
      expect(parsed.serverOrigin).toBe(ORIGIN);
      // E_pub comes back in standard base64 (the native module accepts
      // standard base64, not base64url).
      expect(parsed.newDeviceEphemeralPub).toBe(VALID_E_PUB_BASE64);
    });

    it('rejects v=1 (no compat shim — direction was flipped atomically)', () => {
      const url = `tillit://link?v=1&t=${SESSION}&s=${ORIGIN_B64URL}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects URLs missing the in-band ephemeral pub `e`', () => {
      const url = `tillit://link?v=2&i=${SESSION}&s=${ORIGIN_B64URL}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects URLs missing the server origin `s`', () => {
      const url = `tillit://link?v=2&i=${SESSION}&e=${VALID_E_PUB_URL}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects URLs missing the session id `i`', () => {
      const url = `tillit://link?v=2&s=${ORIGIN_B64URL}&e=${VALID_E_PUB_URL}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects URLs where `s` does not decode to a http(s) URL', () => {
      const garbageB64Url = Buffer.from('not a url', 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const url = `tillit://link?v=2&i=${SESSION}&s=${garbageB64Url}&e=${VALID_E_PUB_URL}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects URLs where `e` is not a 32-byte base64 key', () => {
      const tooShort = 'A'.repeat(10);
      const url = `tillit://link?v=2&i=${SESSION}&s=${ORIGIN_B64URL}&e=${tooShort}`;
      expect(parseProvisioningLinkV2(url)).toBeNull();
    });

    it('rejects non-tillit URLs', () => {
      expect(parseProvisioningLinkV2('https://api.tillit.cc/whatever')).toBeNull();
      expect(parseProvisioningLinkV2('tillit://something-else')).toBeNull();
    });

    it('builds a round-trippable URL', () => {
      const url = buildProvisioningUrlV2({
        sessionId: SESSION,
        serverOrigin: ORIGIN,
        ephemeralPublicKey: VALID_E_PUB_BASE64,
      });
      const parsed = parseProvisioningLinkV2(url);
      expect(parsed).not.toBeNull();
      expect(parsed.sessionId).toBe(SESSION);
      expect(parsed.serverOrigin).toBe(ORIGIN);
      expect(parsed.newDeviceEphemeralPub).toBe(VALID_E_PUB_BASE64);
    });
  });

  describe('originsMatch', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { originsMatch } = require('../services/provisioning-link');

    it('matches identical origins', () => {
      expect(originsMatch('https://api.tillit.cc', 'https://api.tillit.cc')).toBe(true);
    });

    it('tolerates trailing slashes', () => {
      expect(originsMatch('https://api.tillit.cc/', 'https://api.tillit.cc')).toBe(true);
    });

    it('tolerates case differences in scheme and host', () => {
      expect(originsMatch('HTTPS://API.TILLIT.CC', 'https://api.tillit.cc')).toBe(true);
    });

    it('rejects different hosts', () => {
      expect(originsMatch('https://api.tillit.cc', 'https://other.example.com')).toBe(false);
    });

    it('rejects different schemes', () => {
      expect(originsMatch('https://api.tillit.cc', 'http://api.tillit.cc')).toBe(false);
    });

    it('rejects different ports', () => {
      expect(originsMatch('https://api.tillit.cc', 'https://api.tillit.cc:8443')).toBe(false);
    });
  });
});
