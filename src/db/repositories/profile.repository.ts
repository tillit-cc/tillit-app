import { eq, and, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import { profiles, Profile, NewProfile } from '../schema';

export const profileRepository = {
  /**
   * Create a new profile
   */
  async create(profile: NewProfile): Promise<Profile> {
    const db = getDatabase();
    const result = await db.insert(profiles).values(profile).returning();
    return result[0];
  },

  /**
   * Upsert a profile (insert or update)
   */
  async upsert(profile: NewProfile): Promise<Profile> {
    const db = getDatabase();
    const existing = await this.findByUserAndRoom(profile.idUser, profile.idRoom ?? null);

    if (existing) {
      await db
        .update(profiles)
        .set({ ...profile, lastModified: sql`(strftime('%s', 'now'))` })
        .where(eq(profiles.id, existing.id!));
      return { ...existing, ...profile };
    }

    return this.create(profile);
  },

  /**
   * Get profile by ID
   */
  async findById(id: number): Promise<Profile | undefined> {
    const db = getDatabase();
    const result = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get profile by user ID (global profile, no room)
   */
  async findByUser(userId: number): Promise<Profile | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.idUser, userId), sql`${profiles.idRoom} IS NULL`))
      .limit(1);
    return result[0];
  },

  /**
   * Get profile by user ID and room ID
   */
  async findByUserAndRoom(userId: number, roomId: number | null): Promise<Profile | undefined> {
    const db = getDatabase();
    let result;

    if (roomId === null) {
      result = await db
        .select()
        .from(profiles)
        .where(and(eq(profiles.idUser, userId), sql`${profiles.idRoom} IS NULL`))
        .limit(1);
    } else {
      result = await db
        .select()
        .from(profiles)
        .where(and(eq(profiles.idUser, userId), eq(profiles.idRoom, roomId)))
        .limit(1);
    }

    return result[0];
  },

  /**
   * Get all profiles for a room
   */
  async findByRoom(roomId: number): Promise<Profile[]> {
    const db = getDatabase();
    return db.select().from(profiles).where(eq(profiles.idRoom, roomId));
  },

  /**
   * Update profile
   */
  async update(id: number, data: Partial<Profile>): Promise<void> {
    const db = getDatabase();
    await db
      .update(profiles)
      .set({ ...data, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(profiles.id, id));
  },

  /**
   * Delete profile
   */
  async delete(id: number): Promise<void> {
    const db = getDatabase();
    await db.delete(profiles).where(eq(profiles.id, id));
  },

  /**
   * Delete all profiles for a room
   */
  async deleteByRoom(roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(profiles).where(eq(profiles.idRoom, roomId));
  },

  /**
   * Delete profile for a specific user in a room
   */
  async deleteByUserAndRoom(userId: number, roomId: number): Promise<void> {
    const db = getDatabase();
    await db.delete(profiles).where(and(eq(profiles.idUser, userId), eq(profiles.idRoom, roomId)));
  },
};
