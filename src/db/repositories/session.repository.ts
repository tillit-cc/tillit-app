import { eq, and, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import { sessions, Session, NewSession } from '../schema';

export const sessionRepository = {
  /**
   * Create a new session
   */
  async create(session: NewSession): Promise<Session> {
    const db = getDatabase();
    const result = await db.insert(sessions).values(session).returning();
    return result[0];
  },

  /**
   * Upsert a session (insert or update). Keyed on the multi-device triple
   * `(idUser, idRoom, remoteUserDeviceId)`: a peer with two linked devices
   * has two distinct rows, one per device.
   */
  async upsert(session: NewSession): Promise<Session> {
    const db = getDatabase();
    const existing = await this.findByUserRoomAndDevice(
      session.idUser,
      session.idRoom,
      session.remoteUserDeviceId,
    );

    if (existing) {
      await db
        .update(sessions)
        .set({ ...session, lastModified: sql`(strftime('%s', 'now'))` })
        .where(eq(sessions.id, existing.id));
      return { ...existing, ...session };
    }

    return this.create(session);
  },

  /**
   * Get session by ID
   */
  async findById(id: number): Promise<Session | undefined> {
    const db = getDatabase();
    const result = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get any session for `(userId, roomId)`. Multi-device aware: if the
   * peer has multiple linked devices, returns the most recently modified
   * row. Callers that need a specific device should use
   * {@link findByUserRoomAndDevice} instead.
   */
  async findByUserAndRoom(userId: string, roomId: number): Promise<Session | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.idUser, userId), eq(sessions.idRoom, roomId)))
      .orderBy(sql`${sessions.lastModified} DESC`)
      .limit(1);
    return result[0];
  },

  /**
   * Get the session for an exact `(userId, roomId, deviceId)` triple. Used
   * by the multi-device send/redistribute paths where we need to address
   * one specific linked device rather than any device of that peer.
   */
  async findByUserRoomAndDevice(
    userId: string,
    roomId: number,
    deviceId: number,
  ): Promise<Session | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.idUser, userId),
        eq(sessions.idRoom, roomId),
        eq(sessions.remoteUserDeviceId, deviceId),
      ))
      .limit(1);
    return result[0];
  },

  /**
   * Get all sessions across all rooms
   */
  async findAll(): Promise<Session[]> {
    const db = getDatabase();
    return db.select().from(sessions);
  },

  /**
   * Get all sessions for a room
   */
  async findByRoom(roomId: number): Promise<Session[]> {
    const db = getDatabase();
    return db.select().from(sessions).where(eq(sessions.idRoom, roomId));
  },

  /**
   * Update last message timestamp on a single row by primary key.
   */
  async updateLastMessageAt(id: number): Promise<void> {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(sessions)
      .set({ lastMessageAt: now, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(sessions.id, id));
  },

  /**
   * Stamp `lastMessageAt` on EVERY row matching `(userId, roomId)` — i.e.
   * across all linked devices of the user. Used when a message is observed
   * for the peer/self regardless of which specific device authored it,
   * so all the per-device rows stay in sync and `lastModified DESC`
   * ordering on `findByUserAndRoom` does not arbitrarily pick one row.
   */
  async updateLastMessageAtForUserRoom(userId: string, roomId: number): Promise<void> {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(sessions)
      .set({ lastMessageAt: now, lastModified: sql`(strftime('%s', 'now'))` })
      .where(and(eq(sessions.idUser, userId), eq(sessions.idRoom, roomId)));
  },

  /**
   * Mark identity as verified
   */
  async markIdentityVerified(id: number, verified: boolean): Promise<void> {
    const db = getDatabase();
    await db
      .update(sessions)
      .set({ identityVerified: verified ? 1 : 0, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(sessions.id, id));
  },

  /**
   * Delete session
   */
  async delete(id: number): Promise<void> {
    const db = getDatabase();
    await db.delete(sessions).where(eq(sessions.id, id));
  },

  /**
   * Delete all sessions for `(userId, roomId)` — every linked device of
   * the user, in this room. Used when the peer is removed from the room
   * or the room itself goes away.
   */
  async deleteByUserAndRoom(userId: string, roomId: number): Promise<void> {
    const db = getDatabase();
    await db
      .delete(sessions)
      .where(and(eq(sessions.idUser, userId), eq(sessions.idRoom, roomId)));
  },

  /**
   * Delete the session row for a single linked device of a user in a room.
   * Used when one specific peer device (or our own linked device) is
   * revoked while the others stay reachable — symmetric with the libsignal
   * `deleteRemoteSession(userId, deviceId)` native call.
   */
  async deleteByUserRoomAndDevice(
    userId: string,
    roomId: number,
    deviceId: number,
  ): Promise<void> {
    const db = getDatabase();
    await db
      .delete(sessions)
      .where(and(
        eq(sessions.idUser, userId),
        eq(sessions.idRoom, roomId),
        eq(sessions.remoteUserDeviceId, deviceId),
      ));
  },

  /**
   * Delete all sessions for a room
   */
  async deleteByRoom(roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(sessions).where(eq(sessions.idRoom, roomId));
  },

  /**
   * Check if session exists for user and room
   */
  async exists(userId: string, roomId: number): Promise<boolean> {
    const session = await this.findByUserAndRoom(userId, roomId);
    return !!session;
  },

  /**
   * Replace the persisted `remote_known_devices` CSV on every row for a
   * user (across all rooms). The column is denormalized per-row but the
   * value is a per-user property; we keep all rows in sync so any
   * `findByUserAndRoom` lookup at boot returns the latest list.
   *
   * Pass an empty array to clear the cache (e.g. invalidate after
   * `peerDeviceLinked` socket event).
   */
  async updateRemoteKnownDevicesForUser(userId: string, deviceIds: number[]): Promise<void> {
    const db = getDatabase();
    const csv = deviceIds.length === 0
      ? null
      : Array.from(new Set(deviceIds.map((n) => Number(n))))
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b)
          .join(',');
    await db
      .update(sessions)
      .set({ remoteKnownDevices: csv })
      .where(eq(sessions.idUser, userId));
  },
};
