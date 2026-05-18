import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================================================
// ENUMS
// ============================================================================

export const RoomStatus = {
  CREATED: 0,
  ACTIVE: 1,
  ARCHIVED: 2,
  DELETED: 3,
} as const;

export type RoomStatusType = typeof RoomStatus[keyof typeof RoomStatus];

export const MessageStatus = {
  UNDELIVERED: -2,
  FAILED: -1,
  PENDING: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
} as const;

export type MessageStatusType = typeof MessageStatus[keyof typeof MessageStatus];

// ============================================================================
// TABLES
// ============================================================================

/**
 * Servers table - stores configured server connections
 */
export const servers = sqliteTable('server', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  apiUrl: text('api_url').notNull(),
  socketUrl: text('socket_url').notNull(),
  socketNamespace: text('socket_namespace').notNull().default('/chat'),
  isDefault: integer('is_default').notNull().default(0),
  userId: integer('user_id'),
  isTor: integer('is_tor').notNull().default(0),
  status: integer('status').notNull().default(1),
  created: integer('created').default(sql`(strftime('%s', 'now'))`),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`),
});

/**
 * Messages table - stores encrypted chat messages
 */
export const messages = sqliteTable('message', {
  id: text('id').primaryKey(),
  idParent: text('id_parent'),
  type: text('type').notNull(),
  idRoom: integer('id_room').notNull(),
  idUserFrom: integer('id_user_from').notNull(),
  idUserTo: integer('id_user_to'),
  body: text('body').notNull(),
  encryptedBody: text('encrypted_body').notNull(),
  idStatus: integer('id_status').notNull(),
  read: integer('read'),
  timestamp: integer('timestamp').default(sql`(strftime('%s', 'now'))`).notNull(),
  expiryDatetime: integer('expiry_datetime'),
  version: text('version').notNull(),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`),
}, (table) => [
  index('idx_message_room').on(table.idRoom),
  index('idx_message_timestamp').on(table.timestamp),
  index('idx_message_parent').on(table.idParent),
]);

/**
 * Rooms table - stores chat rooms/conversations
 */
export const rooms = sqliteTable('room', {
  id: integer('id').primaryKey(),
  inviteCode: text('invite_code').notNull().unique(),
  idUser: integer('id_user').notNull(),
  username: text('username'),
  image: text('image'),
  name: text('name').notNull(),
  status: integer('status').default(RoomStatus.CREATED).notNull(),
  age: integer('age'),
  timestampUpdate: integer('timestamp_update'),
  timestampCreate: integer('timestamp_create'),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`),
  useSenderKeys: integer('use_sender_keys').default(0).notNull(),
  administered: integer('administered').default(0).notNull(),
  serverId: integer('server_id').notNull().default(0),
}, (table) => [
  index('idx_room_name').on(table.name),
  index('idx_room_last_modified').on(table.lastModified),
  index('idx_room_invite_code').on(table.inviteCode),
]);

/**
 * Profiles table - stores user profiles per room
 */
export const profiles = sqliteTable('profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  idUser: integer('id_user').notNull(),
  idRoom: integer('id_room'),
  username: text('username'),
  image: text('image'),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`),
}, (table) => [
  uniqueIndex('unique_room_user_profile').on(table.idUser, table.idRoom),
]);

/**
 * Sessions table - stores Signal Protocol session metadata
 * Note: Actual session data is stored by the native Signal module
 */
export const sessions = sqliteTable('session', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  idUser: text('id_user').notNull(),
  idRoom: integer('id_room').notNull(),
  remoteUserName: text('remote_user_name').notNull(),
  remoteUserDeviceId: integer('remote_user_device_id').notNull(),
  created: integer('created').default(sql`(strftime('%s', 'now'))`).notNull(),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`).notNull(),
  lastMessageAt: integer('last_message_at'),
  identityVerified: integer('identity_verified').default(0).notNull(),
}, (table) => [
  uniqueIndex('unique_room_user_session').on(table.idUser, table.idRoom),
]);

/**
 * Identity table - stores local user identity metadata
 * Note: IdentityKeyPair is stored in Secure Storage (iOS Keychain/Android Keystore)
 */
export const identities = sqliteTable('identity', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  registrationId: integer('registration_id').notNull(),
  deviceId: integer('device_id').notNull(),
  name: text('name').notNull(),
  created: integer('created').default(sql`(strftime('%s', 'now'))`).notNull(),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`).notNull(),
  lastSignedPreKeyRotation: integer('last_signed_pre_key_rotation'),
});

/**
 * Attachments table - stores message attachments
 */
export const attachments = sqliteTable('attachment', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  size: integer('size').notNull(),
  data: text('data').notNull(),
  lastModified: integer('last_modified').default(sql`(strftime('%s', 'now'))`).notNull(),
});

/**
 * Sender Key Sessions table - for group encryption (Sender Keys protocol)
 */
export const senderKeySessions = sqliteTable('sender_key_session', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  idRoom: integer('id_room').notNull(),
  senderUserId: integer('sender_user_id').notNull(),
  distributionId: text('distribution_id').notNull(),
  chainVersion: integer('chain_version').default(1).notNull(),
  metadata: text('metadata'),
  created: integer('created').default(sql`(strftime('%s', 'now'))`).notNull(),
  lastUsed: integer('last_used').default(sql`(strftime('%s', 'now'))`).notNull(),
  messageCount: integer('message_count').default(0).notNull(),
}, (table) => [
  uniqueIndex('unique_room_sender_session').on(table.idRoom, table.senderUserId),
]);

/**
 * Sender Key Retry Queue - stores failed sender key distributions for retry
 */
export const senderKeyRetryQueue = sqliteTable('sender_key_retry_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roomId: integer('room_id').notNull(),
  senderUserId: integer('sender_user_id').notNull(),
  recipientUserId: integer('recipient_user_id').notNull(),
  distributionId: text('distribution_id').notNull(),
  createdAt: integer('created_at').default(sql`(strftime('%s', 'now'))`).notNull(),
}, (table) => [
  uniqueIndex('unique_room_sender_recipient').on(table.roomId, table.senderUserId, table.recipientUserId),
]);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

export type SenderKeySession = typeof senderKeySessions.$inferSelect;
export type NewSenderKeySession = typeof senderKeySessions.$inferInsert;

export type SenderKeyRetryQueueItem = typeof senderKeyRetryQueue.$inferSelect;
export type NewSenderKeyRetryQueueItem = typeof senderKeyRetryQueue.$inferInsert;
