# TilliT

End-to-end encrypted messaging app built on the [Signal Protocol](https://signal.org/docs/), with optional Tor hidden-service transport for full anonymity.

🌐 Website: <https://tillit.cc>

## Features

- **End-to-end encryption** with Signal Protocol — pair-wise sessions for 1-to-1 and small groups, sender keys for groups of ≥4 members
- **Forward secrecy + post-compromise security** via Double Ratchet
- **Local database encrypted with SQLCipher** (AES-256); key sealed in iOS Keychain / Android Keystore
- **Biometric unlock** (Face ID / Touch ID / fingerprint)
- **Tor hidden-service support** — connect to `.onion` backends via an embedded Tor daemon
- **Ephemeral images** — autodestructing media with on-device screenshot protection
- **Multi-server** — connect to multiple backends in parallel; servers can be public, LAN, or `.onion`

## Architecture

- **App:** Expo (SDK 54) + React Native 0.81, expo-router, NativeWind, Zustand, Drizzle ORM
- **Cryptography:** custom native module wrapping [libsignal](https://github.com/signalapp/libsignal) (Swift on iOS, Kotlin on Android)
- **Anonymity:** custom native module embedding [Arti](https://gitlab.torproject.org/tpo/core/arti) (Rust)
- **Transport:** Socket.IO with auto-reconnect, custom Axios/WebSocket adapter for Tor

For implementation details see [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`CLAUDE.md`](./CLAUDE.md).

## Build

Requirements:

- Node.js 22+
- pnpm 10+
- Xcode 16+ (iOS) / Android Studio with NDK (Android)
- Rust toolchain with iOS targets (only if rebuilding `arti.xcframework` locally — see below)

```bash
pnpm install
pnpm run rebuild            # expo prebuild --clean
pnpm run ios                # iOS device/simulator
pnpm run android            # Android device/emulator
```

The `postinstall` hook downloads a prebuilt `arti.xcframework` (~250 MB) from this repo's GitHub Releases. To rebuild it locally:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
./scripts/build-arti-xcframework.sh
```

### Environment

Default backend is `https://api.tillit.cc`. Override via env variables:

```
EXPO_PUBLIC_API_URL=https://your-backend
EXPO_PUBLIC_SOCKET_URL=https://your-backend
```

## Type check

```bash
node node_modules/typescript/bin/tsc --noEmit
```

## Security

Found a vulnerability? Please follow the responsible disclosure procedure in [`SECURITY.md`](./SECURITY.md) — do **not** open a public issue.

See [`SECURITY-AUDIT-TODO.md`](./SECURITY-AUDIT-TODO.md) for an audit log of resolved and accepted findings.

## Third-party software

- [**libsignal**](https://github.com/signalapp/libsignal) — Signal Protocol implementation, AGPL-3.0
- [**Arti**](https://gitlab.torproject.org/tpo/core/arti) — Tor in Rust, MIT/Apache-2.0
- [**arti-mobile-ex**](https://gitlab.com/guardianproject/tormobile/arti-mobile-ex) — Guardian Project's iOS/Android wrappers for Arti, MIT/Apache-2.0
- [**tor-android**](https://github.com/guardianproject/tor-android) — Tor for Android, BSD-3-Clause
- [**Expo**](https://expo.dev) / **React Native** — MIT
- See `pnpm-lock.yaml` for the full dependency tree

## License

[GNU Affero General Public License v3.0](./LICENSE)

The choice of AGPL-3.0 mirrors the licence of `libsignal`, which TilliT links against, and ensures that anyone offering modified versions of TilliT as a network service must publish their source.
