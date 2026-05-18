import { getDatabase } from '@/db/client';
import { messages, rooms, profiles, NewMessage, NewRoom, NewProfile } from '@/db/schema';
import { roomRepository } from '@/db/repositories';
import { useChatStore } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';
import { saveImageToFile } from '@/utils/image';
import { toLocalRoomId } from '@/utils/server-id';
import { logger } from '@/utils/logger';
import { eq, gte, lt, and } from 'drizzle-orm';

// Seed data uses serverId=0 with room IDs starting at 900000 to avoid conflicts
const SEED_SERVER_ID = 0;
const SEED_ROOM_ID_START = 900_000;
const SEED_USER_ID_START = 900_000;

// Batch size for DB inserts
const INSERT_BATCH_SIZE = 500;

export interface SeedConfig {
  seedServerUrl: string;
  numChats: number;
  msgsPerChat: number;
  numUsers: number;
  includeMedia: boolean;
  mediaRatio?: number;
  locale: string;
  myUsername?: string;
}

export type SeedProgressCallback = (step: string, current: number, total: number) => void;

interface SeedUser {
  id: string;
  username: string;
  avatar_color: string;
  identity_public_key: string;
}

interface SeedMedia {
  media_id: string;
  mime_type: string;
  size: number;
  width: number;
  height: number;
  url: string;
}

interface SeedMessage {
  id: string;
  sender_id: string;
  content: string | null;
  timestamp: string;
  type: string;
  category: string;
  media?: SeedMedia;
}

interface SeedChat {
  id: string;
  name: string;
  invite_code: string;
  created_at: string;
  administered: boolean;
  members: string[];
  messages: SeedMessage[];
}

interface SeedResponse {
  generated_at: string;
  config: Record<string, unknown>;
  my_user_id?: string;
  users: SeedUser[];
  chats: SeedChat[];
}

/**
 * Map user UUIDs to local numeric IDs starting at SEED_USER_ID_START.
 */
function buildUserIdMap(users: SeedUser[]): Map<string, number> {
  const map = new Map<string, number>();
  users.forEach((user, index) => {
    map.set(user.id, SEED_USER_ID_START + index);
  });
  return map;
}

/**
 * Insert records in batches to avoid SQLite variable limits.
 */
async function batchInsert<T extends Record<string, unknown>>(
  table: any,
  records: T[],
) {
  if (records.length === 0) return;
  const db = getDatabase();
  for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + INSERT_BATCH_SIZE);
    await db.insert(table).values(batch);
  }
}

/**
 * Insert records in batches, ignoring UNIQUE constraint conflicts.
 */
async function batchInsertIgnoreConflicts<T extends Record<string, unknown>>(
  table: any,
  records: T[],
) {
  if (records.length === 0) return;
  const db = getDatabase();
  for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + INSERT_BATCH_SIZE);
    await db.insert(table).values(batch).onConflictDoNothing();
  }
}

/**
 * Download an image from the seed server and return its base64 data.
 * Returns null if the download fails.
 */
async function downloadImage(seedServerUrl: string, mediaUrl: string): Promise<string | null> {
  try {
    const url = `${seedServerUrl}${mediaUrl}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        // Strip the data:...;base64, prefix
        const base64 = dataUrl.split(',')[1] || '';
        resolve(base64);
      };
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Seed the local database with demo data from the seeding server.
 */
export async function seedDemoData(
  config: SeedConfig,
  onProgress?: SeedProgressCallback,
): Promise<{ roomCount: number; messageCount: number }> {
  const { seedServerUrl, numChats, msgsPerChat, numUsers, includeMedia, mediaRatio = 0.15, locale, myUsername } = config;

  // Step 1: Fetch seed data
  onProgress?.('Downloading seed data...', 0, 1);
  logger.info(`[Seed] Fetching from ${seedServerUrl}/seed`);

  const useStreaming = numChats > 100;
  let seedData: SeedResponse;

  const buildParams = () => {
    const params = new URLSearchParams({
      num_chats: String(numChats),
      msgs_per_chat: String(msgsPerChat),
      num_users: String(numUsers),
      include_media: String(includeMedia),
      media_ratio: String(mediaRatio),
      locale,
    });
    if (myUsername) params.set('my_username', myUsername);
    return params;
  };

  if (useStreaming) {
    seedData = await fetchSeedStreaming(seedServerUrl, config, onProgress);
  } else {
    const params = buildParams();
    const response = await fetch(`${seedServerUrl}/seed?${params}`);
    if (!response.ok) {
      throw new Error(`Seed server error: ${response.status} ${response.statusText}`);
    }
    seedData = await response.json();
  }

  onProgress?.('Processing data...', 1, 1);

  const currentUserId = useAuthStore.getState().userId;
  const myUserUuid = seedData.my_user_id ?? null;
  const userIdMap = buildUserIdMap(seedData.users);
  const usersMap = new Map(seedData.users.map(u => [u.id, u]));

  // Step 2: Insert rooms
  onProgress?.('Inserting rooms...', 0, seedData.chats.length);
  const roomRecords: NewRoom[] = [];
  const roomIdMap = new Map<string, number>(); // chat UUID -> local room ID

  for (let i = 0; i < seedData.chats.length; i++) {
    const chat = seedData.chats[i];
    const localRoomId = toLocalRoomId(SEED_SERVER_ID, SEED_ROOM_ID_START + i);
    roomIdMap.set(chat.id, localRoomId);

    const createdAt = Math.floor(new Date(chat.created_at).getTime() / 1000);
    roomRecords.push({
      id: localRoomId,
      name: chat.name,
      inviteCode: chat.invite_code,
      idUser: userIdMap.get(chat.members[0]) ?? SEED_USER_ID_START,
      status: 0,
      administered: chat.administered ? 1 : 0,
      timestampCreate: createdAt,
      timestampUpdate: createdAt,
      lastModified: createdAt,
      serverId: SEED_SERVER_ID,
      useSenderKeys: 0,
    });
  }

  await batchInsert(rooms, roomRecords);
  onProgress?.('Inserting rooms...', seedData.chats.length, seedData.chats.length);

  // Step 3: Insert profiles
  onProgress?.('Inserting profiles...', 0, seedData.chats.length);
  const profileRecords: NewProfile[] = [];

  for (const chat of seedData.chats) {
    const localRoomId = roomIdMap.get(chat.id)!;
    for (const memberUuid of chat.members) {
      const user = usersMap.get(memberUuid);
      if (!user) continue;

      const isMeUser = myUserUuid !== null && memberUuid === myUserUuid;
      const profileUserId = (isMeUser && currentUserId) ? currentUserId : (userIdMap.get(memberUuid) ?? SEED_USER_ID_START);

      profileRecords.push({
        idUser: profileUserId,
        idRoom: localRoomId,
        username: user.username,
        image: null,
      });
    }
  }

  // Use onConflictDoNothing to handle re-seeding without clearing first
  await batchInsertIgnoreConflicts(profiles, profileRecords);
  onProgress?.('Inserting profiles...', seedData.chats.length, seedData.chats.length);

  // Step 4: Insert messages (with optional media download)
  let totalMessages = 0;
  const totalExpected = seedData.chats.reduce((sum, c) => sum + c.messages.length, 0);
  let processedMessages = 0;

  for (const chat of seedData.chats) {
    const localRoomId = roomIdMap.get(chat.id)!;
    const messageRecords: NewMessage[] = [];

    for (const msg of chat.messages) {
      const isMine = myUserUuid !== null && msg.sender_id === myUserUuid;
      const localUserId = (isMine && currentUserId) ? currentUserId : (userIdMap.get(msg.sender_id) ?? SEED_USER_ID_START);
      const timestampMs = new Date(msg.timestamp).getTime();
      let body: string;
      let type = msg.type;

      if (msg.type === 'image' && msg.media && includeMedia) {
        // Try to download the image
        const base64 = await downloadImage(seedServerUrl, msg.media.url);
        if (base64) {
          // Save to filesystem
          try {
            await saveImageToFile(base64, msg.id, msg.media.mime_type);
            body = JSON.stringify({
              base64,
              mimeType: msg.media.mime_type,
              width: msg.media.width,
              height: msg.media.height,
            });
          } catch {
            body = '[Image not loaded]';
            type = 'text';
          }
        } else {
          body = '[Image not loaded]';
          type = 'text';
        }
      } else if (msg.type === 'image') {
        body = '[Image]';
        type = 'text';
      } else {
        body = msg.content ?? '';
      }

      messageRecords.push({
        id: msg.id,
        idRoom: localRoomId,
        idUserFrom: localUserId,
        idUserTo: null,
        type,
        body,
        encryptedBody: '',
        idStatus: 4, // READ
        read: Math.floor(timestampMs / 1000),
        timestamp: timestampMs,
        version: '2.0',
        idParent: null,
      });

      processedMessages++;
      if (processedMessages % 100 === 0) {
        onProgress?.('Inserting messages...', processedMessages, totalExpected);
      }
    }

    await batchInsert(messages, messageRecords);
    totalMessages += messageRecords.length;
  }

  onProgress?.('Inserting messages...', totalExpected, totalExpected);

  // Step 5: Refresh the Zustand store
  onProgress?.('Refreshing rooms...', 0, 1);
  const userId = useAuthStore.getState().userId;
  if (userId) {
    const allRooms = await roomRepository.findAllWithMetadata(userId);
    useChatStore.getState().setAllRooms(allRooms);
  }
  onProgress?.('Done', 1, 1);

  logger.info(`[Seed] Inserted ${roomRecords.length} rooms, ${totalMessages} messages, ${profileRecords.length} profiles`);

  return { roomCount: roomRecords.length, messageCount: totalMessages };
}

/**
 * Fetch seed data using NDJSON streaming for large datasets.
 */
async function fetchSeedStreaming(
  seedServerUrl: string,
  config: SeedConfig,
  onProgress?: SeedProgressCallback,
): Promise<SeedResponse> {
  const params = new URLSearchParams({
    num_chats: String(config.numChats),
    msgs_per_chat: String(config.msgsPerChat),
    num_users: String(config.numUsers),
    include_media: String(config.includeMedia),
    media_ratio: String(config.mediaRatio ?? 0.15),
    locale: config.locale,
  });
  if (config.myUsername) params.set('my_username', config.myUsername);

  const response = await fetch(`${seedServerUrl}/seed/stream?${params}`);
  if (!response.ok) {
    throw new Error(`Seed server error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.trim());

  // First line is the header with users + config
  const header = JSON.parse(lines[0]);
  const chats: SeedChat[] = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const chat = JSON.parse(lines[i]);
      chats.push(chat);
      onProgress?.('Downloading seed data...', i, lines.length - 1);
    } catch {
      // Skip malformed lines
    }
  }

  return {
    generated_at: header.generated_at,
    config: header.config,
    users: header.users,
    chats,
  };
}

/**
 * Remove all seed data from the database.
 */
export async function clearSeedData(onProgress?: SeedProgressCallback): Promise<void> {
  const db = getDatabase();

  onProgress?.('Finding seed rooms...', 0, 1);

  // Find all seed rooms (serverId=0, roomId >= SEED_ROOM_ID_START)
  const minId = toLocalRoomId(SEED_SERVER_ID, SEED_ROOM_ID_START);
  const maxId = toLocalRoomId(SEED_SERVER_ID + 1, 0); // Next server's start

  const seedRooms = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(gte(rooms.id, minId), lt(rooms.id, maxId)));

  if (seedRooms.length === 0) {
    onProgress?.('No seed data found', 1, 1);
    return;
  }

  const roomIds = seedRooms.map(r => r.id);
  const total = roomIds.length;

  onProgress?.('Deleting seed data...', 0, total);

  for (let i = 0; i < roomIds.length; i++) {
    const roomId = roomIds[i];
    await db.delete(messages).where(eq(messages.idRoom, roomId));
    await db.delete(profiles).where(eq(profiles.idRoom, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));

    if ((i + 1) % 10 === 0 || i === roomIds.length - 1) {
      onProgress?.('Deleting seed data...', i + 1, total);
    }
  }

  // Refresh Zustand store
  onProgress?.('Refreshing rooms...', 0, 1);
  const userId = useAuthStore.getState().userId;
  if (userId) {
    const allRooms = await roomRepository.findAllWithMetadata(userId);
    useChatStore.getState().setAllRooms(allRooms);
  }

  onProgress?.('Done', 1, 1);
  logger.info(`[Seed] Cleared ${total} seed rooms`);
}