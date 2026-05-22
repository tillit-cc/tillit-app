import { eq, and, desc, asc, lt, notInArray, inArray, isNull, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import { messages, Message, NewMessage, MessageStatus } from '../schema';

export const messageRepository = {
  /**
   * Create a new message
   */
  async create(message: NewMessage): Promise<Message> {
    const db = getDatabase();
    const result = await db.insert(messages).values(message).returning();
    return result[0];
  },

  /**
   * Get message by ID
   */
  async findById(id: string): Promise<Message | undefined> {
    const db = getDatabase();
    const result = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get messages by room ID with pagination
   */
  async findByRoom(
    roomId: number,
    options: { limit?: number; beforeTimestamp?: number } = {}
  ): Promise<Message[]> {
    const db = getDatabase();
    const { limit = 50, beforeTimestamp } = options;

    let query = db.select().from(messages).where(eq(messages.idRoom, roomId));

    if (beforeTimestamp) {
      query = db
        .select()
        .from(messages)
        .where(and(eq(messages.idRoom, roomId), lt(messages.timestamp, beforeTimestamp)));
    }

    return query.orderBy(desc(messages.timestamp)).limit(limit);
  },

  /**
   * Get replies to a message
   */
  async findReplies(parentId: string): Promise<Message[]> {
    const db = getDatabase();
    return db
      .select()
      .from(messages)
      .where(eq(messages.idParent, parentId))
      .orderBy(asc(messages.timestamp));
  },

  /**
   * Update message status
   */
  async updateStatus(id: string, status: number): Promise<void> {
    const db = getDatabase();
    await db
      .update(messages)
      .set({ idStatus: status, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(messages.id, id));
  },

  /**
   * Mark message as read. Idempotent: skips rows that already have `read`
   * set so re-applying the same MESSAGE_READ self-fanout doesn't keep
   * pushing the timestamp forward (and doesn't burn writes on no-op).
   */
  async markAsRead(id: string): Promise<void> {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(messages)
      .set({ read: now, lastModified: sql`(strftime('%s', 'now'))` })
      .where(and(eq(messages.id, id), isNull(messages.read)));
  },

  /**
   * Update decrypted body
   */
  async updateBody(id: string, body: string): Promise<void> {
    const db = getDatabase();
    await db
      .update(messages)
      .set({ body, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(messages.id, id));
  },

  /**
   * Get messages by room ID and type (e.g. IMAGE)
   */
  async findByRoomAndType(roomId: number, type: string): Promise<Message[]> {
    const db = getDatabase();
    return db
      .select()
      .from(messages)
      .where(and(eq(messages.idRoom, roomId), eq(messages.type, type)));
  },

  /**
   * Delete message
   */
  async delete(id: string): Promise<void> {
    const db = getDatabase();
    await db.delete(messages).where(eq(messages.id, id));
  },

  /**
   * Delete all messages in a room
   */
  async deleteByRoom(roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(messages).where(eq(messages.idRoom, roomId));
  },

  /**
   * Delete all messages from a specific user in a room
   */
  async deleteByUserInRoom(roomId: number, userId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(messages).where(and(eq(messages.idRoom, roomId), eq(messages.idUserFrom, userId)));
  },

  /**
   * Get unread count for a room
   */
  async getUnreadCount(roomId: number): Promise<number> {
    const db = getDatabase();
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.idRoom, roomId), sql`${messages.read} IS NULL`));
    return result[0]?.count ?? 0;
  },

  /**
   * Count unread INCOMING messages for a room — excludes any sender in
   * `excludeUserIds` (own userId + room serverUserId). Used after a
   * MESSAGE_READ self-fanout applies `read` on incoming rows: the new
   * unread counter for the room is whatever rows are still unread, minus
   * the senders that count as "self" (self-fanout copies of our own
   * outgoing message also live in the messages table but must not
   * contribute to the unread badge).
   */
  async countUnreadIncoming(roomId: number, excludeUserIds: number[]): Promise<number> {
    const db = getDatabase();
    const filtered = excludeUserIds.filter((u) => Number.isFinite(u));
    const where = filtered.length > 0
      ? and(
          eq(messages.idRoom, roomId),
          isNull(messages.read),
          notInArray(messages.idUserFrom, filtered),
        )
      : and(eq(messages.idRoom, roomId), isNull(messages.read));
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(where);
    return result[0]?.count ?? 0;
  },

  /**
   * Find all messages with a given status
   */
  async findByStatus(status: number): Promise<Message[]> {
    const db = getDatabase();
    return db.select().from(messages).where(eq(messages.idStatus, status));
  },

  /**
   * Update status for all messages matching a given status
   */
  async updateAllByStatus(fromStatus: number, toStatus: number): Promise<number> {
    const db = getDatabase();
    const result = await db
      .update(messages)
      .set({ idStatus: toStatus, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(messages.idStatus, fromStatus))
      .returning();
    return result.length;
  },

  /**
   * Find messages stuck in SENDING or PENDING status, ordered by timestamp ASC.
   */
  async findStuckSending(): Promise<Message[]> {
    const db = getDatabase();
    return db
      .select()
      .from(messages)
      .where(
        inArray(messages.idStatus, [MessageStatus.PENDING, MessageStatus.SENDING])
      )
      .orderBy(asc(messages.timestamp));
  },

  /**
   * Replace a message ID (primary key) and optionally update its timestamp.
   * Used when the server assigns a new UUID for sender key messages.
   */
  async replaceId(oldId: string, newId: string, timestamp?: number): Promise<void> {
    const db = getDatabase();
    const updates: any = { id: newId, lastModified: sql`(strftime('%s', 'now'))` };
    if (timestamp) updates.timestamp = timestamp;
    await db.update(messages).set(updates).where(eq(messages.id, oldId));
  },

  /**
   * Update expiry datetime (for ephemeral messages)
   */
  async updateExpiry(id: string, expiryDatetime: number): Promise<void> {
    const db = getDatabase();
    await db
      .update(messages)
      .set({ expiryDatetime, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(messages.id, id));
  },

  /**
   * Find expired ephemeral messages that still have media data in body
   */
  async findExpiredEphemeral(): Promise<Message[]> {
    const db = getDatabase();
    const now = Date.now();
    return db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.type, 'ephemeral_image'),
          sql`${messages.expiryDatetime} IS NOT NULL`,
          lt(messages.expiryDatetime, now)
        )
      );
  },

  /**
   * Get last message timestamp for a room
   */
  async getLastMessageTimestamp(roomId: number): Promise<number | null> {
    const db = getDatabase();
    const result = await db
      .select({ timestamp: messages.timestamp })
      .from(messages)
      .where(eq(messages.idRoom, roomId))
      .orderBy(desc(messages.timestamp))
      .limit(1);
    return result[0]?.timestamp ?? null;
  },
};
