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
   * Upsert a session (insert or update)
   */
  async upsert(session: NewSession): Promise<Session> {
    const db = getDatabase();
    const existing = await this.findByUserAndRoom(session.idUser, session.idRoom);

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
   * Get session by user ID and room ID
   */
  async findByUserAndRoom(userId: string, roomId: number): Promise<Session | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.idUser, userId), eq(sessions.idRoom, roomId)))
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
   * Update last message timestamp
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
   * Delete session by user and room
   */
  async deleteByUserAndRoom(userId: string, roomId: number): Promise<void> {
    const db = getDatabase();
    await db
      .delete(sessions)
      .where(and(eq(sessions.idUser, userId), eq(sessions.idRoom, roomId)));
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
};
