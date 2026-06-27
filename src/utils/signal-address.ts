import { getServerIdFromRoomId } from './server-id';

/**
 * Namespace a remote user's libsignal address by the server they belong to.
 *
 * libsignal's native session **and** identity stores are keyed by the
 * `ProtocolAddress` name — i.e. the userId string we hand to the native
 * module. userIds are NOT unique across servers: every server restarts its
 * numbering from 1, 2, 3… So a bare userId collides across servers. Once the
 * identity-trust check became strict (commits 87ffdff / c373f71), that
 * collision surfaces as `IdentityKeyMismatchError` for a peer we already knew
 * on a *different* server — the multi-server regression tracked in
 * frontend-0027.
 *
 * The fix is to namespace the address name by serverId:
 *
 *   - The **default** server (serverId 0 — the historical, pre-multi-server
 *     one) keeps the BARE userId, so existing native-store entries keep
 *     resolving. No migration / re-handshake for the overwhelmingly common
 *     mono-server install.
 *   - Every **non-default** server gets a `"${serverId}:${userId}"` prefix, so
 *     its entries can never collide with the default server's (or each
 *     other's). A fresh server therefore starts from an empty namespace →
 *     clean TOFU on first contact, no false MITM alert.
 *
 * The SQLite `session` table stays keyed by the bare `(idUser, idRoom,
 * deviceId)` triple — the local roomId already encodes the server (via the
 * server-id offset, see {@link getServerIdFromRoomId}), so it is unambiguous.
 * Only the strings handed to the native module are namespaced.
 */
export function signalAddressName(serverId: number, userId: string | number): string {
  return serverId === 0 ? String(userId) : `${serverId}:${userId}`;
}

/**
 * Convenience wrapper: derive the serverId from a local roomId, then namespace
 * the userId. Every native call site already has the roomId in scope, so this
 * is the form used almost everywhere.
 */
export function signalAddressNameForRoom(roomId: number, userId: string | number): string {
  return signalAddressName(getServerIdFromRoomId(roomId), userId);
}
