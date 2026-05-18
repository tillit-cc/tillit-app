import { eq, desc, sql, and, ne, gte, lt } from 'drizzle-orm';
import { getDatabase } from '../client';
import { rooms, Room, NewRoom, RoomStatus, messages, sessions } from '../schema';

export type RoomWithMetadata = Room & {
  hasSession?: boolean;
  lastMessageTime?: number | null;
  unreadCount?: number;
};

export const roomRepository = {
  /**
   * Create a new room
   */
  async create(room: NewRoom): Promise<Room> {
    const db = getDatabase();
    const result = await db.insert(rooms).values(room).returning();
    return result[0];
  },

  /**
   * Upsert a room (insert or update)
   */
  async upsert(room: NewRoom & { id: number }): Promise<Room> {
    const db = getDatabase();
    const existing = await this.findById(room.id);

    if (existing) {
      await db
        .update(rooms)
        .set({ ...room, lastModified: sql`(strftime('%s', 'now'))` })
        .where(eq(rooms.id, room.id));
      return { ...existing, ...room };
    }

    return this.create(room);
  },

  /**
   * Get room by ID
   */
  async findById(id: number): Promise<Room | undefined> {
    const db = getDatabase();
    const result = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get room by invite code
   */
  async findByInviteCode(inviteCode: string): Promise<Room | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(rooms)
      .where(eq(rooms.inviteCode, inviteCode))
      .limit(1);
    return result[0];
  },

  /**
   * Get all active rooms with metadata (session status, last message, unread count)
   */
  async findAllWithMetadata(userId: number): Promise<RoomWithMetadata[]> {
    const db = getDatabase();

    // Get all non-deleted rooms
    const allRooms = await db
      .select()
      .from(rooms)
      .where(ne(rooms.status, RoomStatus.DELETED))
      .orderBy(desc(rooms.lastModified));

    // Enrich with metadata
    const enrichedRooms: RoomWithMetadata[] = [];

    for (const room of allRooms) {
      // Check for active session
      const sessionResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(sessions)
        .where(eq(sessions.idRoom, room.id));
      const hasSession = (sessionResult[0]?.count ?? 0) > 0;

      // Get last message timestamp
      const lastMsgResult = await db
        .select({ timestamp: messages.timestamp })
        .from(messages)
        .where(eq(messages.idRoom, room.id))
        .orderBy(desc(messages.timestamp))
        .limit(1);
      const lastMessageTime = lastMsgResult[0]?.timestamp ?? null;

      // Get unread count
      const unreadResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.idRoom, room.id),
            sql`${messages.read} IS NULL`,
            ne(messages.idUserFrom, userId)
          )
        );
      const unreadCount = unreadResult[0]?.count ?? 0;

      enrichedRooms.push({
        ...room,
        hasSession,
        lastMessageTime,
        unreadCount,
      });
    }

    // Sort by last message time (rooms with messages first)
    return enrichedRooms.sort((a, b) => {
      const timeA = a.lastMessageTime ?? a.lastModified ?? 0;
      const timeB = b.lastMessageTime ?? b.lastModified ?? 0;
      return timeB - timeA;
    });
  },

  /**
   * Update room status
   */
  async updateStatus(id: number, status: typeof RoomStatus[keyof typeof RoomStatus]): Promise<void> {
    const db = getDatabase();
    await db
      .update(rooms)
      .set({ status, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(rooms.id, id));
  },

  /**
   * Update room details
   */
  async update(id: number, data: Partial<Room>): Promise<void> {
    const db = getDatabase();
    await db
      .update(rooms)
      .set({ ...data, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(rooms.id, id));
  },

  /**
   * Delete room (soft delete by setting status)
   */
  async delete(id: number): Promise<void> {
    await this.updateStatus(id, RoomStatus.DELETED);
  },

  /**
   * Hard delete room and all related data
   */
  async hardDelete(id: number): Promise<void> {
    const db = getDatabase();
    // Delete messages first due to foreign key-like relationship
    await db.delete(messages).where(eq(messages.idRoom, id));
    await db.delete(sessions).where(eq(sessions.idRoom, id));
    await db.delete(rooms).where(eq(rooms.id, id));
  },

  /**
   * Find all rooms belonging to a specific server (by ID range).
   * Room IDs encode the server: serverId * 1_000_000_000 + backendRoomId
   */
  async findByServerId(serverId: number): Promise<Room[]> {
    const db = getDatabase();
    const multiplier = 1_000_000_000;
    const minId = serverId * multiplier;
    const maxId = (serverId + 1) * multiplier;

    return db
      .select()
      .from(rooms)
      .where(and(gte(rooms.id, minId), lt(rooms.id, maxId)));
  },

  /**
   * Hard delete all rooms (and related data) belonging to a specific server.
   */
  async hardDeleteByServerId(serverId: number): Promise<number[]> {
    const serverRooms = await this.findByServerId(serverId);
    const deletedIds: number[] = [];

    for (const room of serverRooms) {
      await this.hardDelete(room.id);
      deletedIds.push(room.id);
    }

    return deletedIds;
  },
};
