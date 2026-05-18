import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import { identities, Identity, NewIdentity } from '../schema';

export const identityRepository = {
  /**
   * Create a new identity
   */
  async create(identity: NewIdentity): Promise<Identity> {
    const db = getDatabase();
    const result = await db.insert(identities).values(identity).returning();
    return result[0];
  },

  /**
   * Get identity by ID
   */
  async findById(id: number): Promise<Identity | undefined> {
    const db = getDatabase();
    const result = await db.select().from(identities).where(eq(identities.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get identity by name (email/user identifier)
   */
  async findByName(name: string): Promise<Identity | undefined> {
    const db = getDatabase();
    const result = await db
      .select()
      .from(identities)
      .where(eq(identities.name, name))
      .limit(1);
    return result[0];
  },

  /**
   * Get the local user identity (there should only be one)
   */
  async getLocalIdentity(): Promise<Identity | undefined> {
    const db = getDatabase();
    const result = await db.select().from(identities).limit(1);
    return result[0];
  },

  /**
   * Check if a local identity exists
   */
  async hasLocalIdentity(): Promise<boolean> {
    const identity = await this.getLocalIdentity();
    return !!identity;
  },

  /**
   * Update identity
   */
  async update(id: number, data: Partial<Identity>): Promise<void> {
    const db = getDatabase();
    await db
      .update(identities)
      .set({ ...data, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(identities.id, id));
  },

  /**
   * Update last signed pre-key rotation timestamp
   */
  async updateLastSignedPreKeyRotation(id: number): Promise<void> {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(identities)
      .set({
        lastSignedPreKeyRotation: now,
        lastModified: sql`(strftime('%s', 'now'))`,
      })
      .where(eq(identities.id, id));
  },

  /**
   * Delete identity
   */
  async delete(id: number): Promise<void> {
    const db = getDatabase();
    await db.delete(identities).where(eq(identities.id, id));
  },

  /**
   * Clear all identities (used when logging out)
   */
  async clearAll(): Promise<void> {
    const db = getDatabase();
    await db.delete(identities);
  },
};
