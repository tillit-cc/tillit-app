import { eq, and, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import {
  senderKeySessions,
  senderKeyRetryQueue,
  SenderKeySession,
  NewSenderKeySession,
  SenderKeyRetryQueueItem,
  NewSenderKeyRetryQueueItem,
} from '../schema';

export const senderKeyRepository = {
  // ============================================================================
  // SENDER KEY SESSIONS
  // ============================================================================

  /**
   * Create a new sender key session
   */
  async createSession(session: NewSenderKeySession): Promise<SenderKeySession> {
    const db = getDatabase();
    const result = await db.insert(senderKeySessions).values(session).returning();
    return result[0];
  },

  /**
   * Upsert a sender key session
   */
  async upsertSession(session: NewSenderKeySession): Promise<SenderKeySession> {
    const db = getDatabase();
    const existing = await this.findSessionByRoomAndSender(session.idRoom, session.senderUserId);

    if (existing) {
      await db
        .update(senderKeySessions)
        .set({ ...session, lastUsed: sql`(strftime('%s', 'now'))` })
        .where(eq(senderKeySessions.id, existing.id));
      return { ...existing, ...session };
    }

    return this.createSession(session);
  },

  /**
   * Find session by room and sender
   */
  async findSessionByRoomAndSender(
    roomId: number,
    senderUserId: number
  ): Promise<SenderKeySession | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(senderKeySessions)
      .where(
        and(
          eq(senderKeySessions.idRoom, roomId),
          eq(senderKeySessions.senderUserId, senderUserId)
        )
      )
      .limit(1);
    return result[0];
  },

  /**
   * Find all sessions for a room
   */
  async findSessionsByRoom(roomId: number): Promise<SenderKeySession[]> {
    const db = getDatabase();
    return db.select().from(senderKeySessions).where(eq(senderKeySessions.idRoom, roomId));
  },

  /**
   * Update message count and last used
   */
  async incrementMessageCount(sessionId: number): Promise<void> {
    const db = getDatabase();
    await db
      .update(senderKeySessions)
      .set({
        messageCount: sql`${senderKeySessions.messageCount} + 1`,
        lastUsed: sql`(strftime('%s', 'now'))`,
      })
      .where(eq(senderKeySessions.id, sessionId));
  },

  /**
   * Update chain version (after key rotation)
   */
  async updateChainVersion(sessionId: number, newVersion: number): Promise<void> {
    const db = getDatabase();
    await db
      .update(senderKeySessions)
      .set({
        chainVersion: newVersion,
        messageCount: 0,
        lastUsed: sql`(strftime('%s', 'now'))`,
      })
      .where(eq(senderKeySessions.id, sessionId));
  },

  /**
   * Delete session
   */
  async deleteSession(sessionId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(senderKeySessions).where(eq(senderKeySessions.id, sessionId));
  },

  /**
   * Delete all sessions for a room
   */
  async deleteSessionsByRoom(roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(senderKeySessions).where(eq(senderKeySessions.idRoom, roomId));
  },

  // ============================================================================
  // RETRY QUEUE
  // ============================================================================

  /**
   * Add item to retry queue
   */
  async addToRetryQueue(item: NewSenderKeyRetryQueueItem): Promise<SenderKeyRetryQueueItem> {
    const db = getDatabase();
    // Use upsert behavior
    const existing = await this.findRetryQueueItem(
      item.roomId,
      item.senderUserId,
      item.recipientUserId
    );

    if (existing) {
      // Update existing item
      await db
        .update(senderKeyRetryQueue)
        .set({ distributionId: item.distributionId, createdAt: sql`(strftime('%s', 'now'))` })
        .where(eq(senderKeyRetryQueue.id, existing.id));
      return { ...existing, ...item };
    }

    const result = await db.insert(senderKeyRetryQueue).values(item).returning();
    return result[0];
  },

  /**
   * Find specific retry queue item
   */
  async findRetryQueueItem(
    roomId: number,
    senderUserId: number,
    recipientUserId: number
  ): Promise<SenderKeyRetryQueueItem | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(senderKeyRetryQueue)
      .where(
        and(
          eq(senderKeyRetryQueue.roomId, roomId),
          eq(senderKeyRetryQueue.senderUserId, senderUserId),
          eq(senderKeyRetryQueue.recipientUserId, recipientUserId)
        )
      )
      .limit(1);
    return result[0];
  },

  /**
   * Get all pending retries for a recipient
   */
  async findRetryQueueByRecipient(recipientUserId: number): Promise<SenderKeyRetryQueueItem[]> {
    const db = getDatabase();
    return db
      .select()
      .from(senderKeyRetryQueue)
      .where(eq(senderKeyRetryQueue.recipientUserId, recipientUserId));
  },

  /**
   * Get all pending retries for a room
   */
  async findRetryQueueByRoom(roomId: number): Promise<SenderKeyRetryQueueItem[]> {
    const db = getDatabase();
    return db.select().from(senderKeyRetryQueue).where(eq(senderKeyRetryQueue.roomId, roomId));
  },

  /**
   * Remove item from retry queue
   */
  async removeFromRetryQueue(id: number): Promise<void> {
    const db = getDatabase();
    await db.delete(senderKeyRetryQueue).where(eq(senderKeyRetryQueue.id, id));
  },

  /**
   * Remove all retry queue items for a room
   */
  async clearRetryQueueByRoom(roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(senderKeyRetryQueue).where(eq(senderKeyRetryQueue.roomId, roomId));
  },
};
