import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '../client';
import { servers, Server, NewServer } from '../schema';

export const serverRepository = {
  async findAll(): Promise<Server[]> {
    const db = getDatabase();
    return db.select().from(servers);
  },

  async findById(id: number): Promise<Server | undefined> {
    const db = getDatabase();
    const result = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
    return result[0];
  },

  async findDefault(): Promise<Server | undefined> {
    const db = getDatabase();
    const result = await db.select().from(servers).where(eq(servers.isDefault, 1)).limit(1);
    return result[0];
  },

  async create(server: NewServer): Promise<Server> {
    const db = getDatabase();
    const result = await db.insert(servers).values(server).returning();
    return result[0];
  },

  async update(id: number, data: Partial<NewServer>): Promise<void> {
    const db = getDatabase();
    await db
      .update(servers)
      .set({ ...data, lastModified: sql`(strftime('%s', 'now'))` })
      .where(eq(servers.id, id));
  },

  async remove(id: number): Promise<void> {
    const db = getDatabase();
    await db.delete(servers).where(eq(servers.id, id));
  },
};
