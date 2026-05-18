# Security Policy

TilliT is an end-to-end encrypted messaging app. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Instead, report privately by email to:

> **security@tillit.cc**

If you don't get an acknowledgement within 72 hours, please follow up — your report may have been caught by spam filtering.

When reporting, include if possible:

- A clear description of the issue and its impact
- Steps to reproduce, or a proof-of-concept
- Affected versions / platforms (iOS, Android, build number)
- Any suggested mitigation

We will acknowledge receipt, investigate, and keep you updated on the fix timeline. We are happy to credit reporters in release notes unless they prefer to remain anonymous.

## Scope

In scope:

- The TilliT mobile app (this repository)
- The Signal Protocol bindings in `modules/signal-protocol/`
- The Tor proxy bindings in `modules/tor-proxy/`
- The screenshot-protection bindings in `modules/secure-view/`
- Interaction with the TilliT backend API at `https://api.tillit.cc`

Out of scope (please report upstream instead):

- Vulnerabilities in `libsignal` itself → <https://github.com/signalapp/libsignal/security>
- Vulnerabilities in `Arti` / `tor-android` → Tor Project / Guardian Project
- Vulnerabilities in Expo, React Native, or other transitive dependencies → respective upstream projects

## Known accepted trade-offs

The following items have been considered and intentionally not addressed; please do not report them as new issues:

- **No certificate pinning.** Let's Encrypt rotation cycles make pinning operationally fragile; the Signal Protocol E2EE already protects message contents against TLS MITM.
- **JWT signature not verified client-side.** The client only reads `exp` / `sub` for UX. Cryptographic validation happens server-side.
- **Incoming message timestamps not validated.** Messages queued offline can legitimately have old timestamps; rejecting them would break the resend-on-reconnect queue.

See [`SECURITY-AUDIT-TODO.md`](./SECURITY-AUDIT-TODO.md) for the full audit log of resolved findings.

## Cryptographic design

TilliT uses the Signal Protocol with the following choices:

- **Pair-wise sessions (Double Ratchet)** for 1-to-1 and small groups (<4 members)
- **Sender Keys** for larger groups (≥4 members), with rotation every 1000 messages or 7 days
- **Forward secrecy** + **post-compromise security** via Double Ratchet
- **Identity keys** stored in iOS Keychain / Android Keystore — never leave the device
- **SQLCipher (AES-256)** for the local database; key derived per-install and stored in the secure enclave
- **Numeric safety numbers** (`NumericFingerprintGenerator`, 5200 iterations, SHA-512) for out-of-band verification

For full implementation details see [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`CLAUDE.md`](./CLAUDE.md).

## Responsible disclosure timeline

We aim to:

- Acknowledge reports within **72 hours**
- Provide an initial assessment within **7 days**
- Ship a fix in the **next regular release** for medium-severity issues, or an **out-of-band release** for critical issues

We ask that reporters wait until a fix has shipped before public disclosure, with a default coordination window of **90 days**.
