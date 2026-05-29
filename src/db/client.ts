import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, deleteDatabaseSync, SQLiteDatabase } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import SignalProtocol from 'signal-protocol';
import * as schema from './schema';

// Database name
const DATABASE_NAME = 'tillit.db';

// Hardware-protected storage key (under the Signal module's `tillit_protected/`
// namespace). The DB encryption key lives behind the same biometric ACL as the
// Signal identity material — no second prompt at cold start.
const DB_KEY_PROTECTED_KEY = 'tillit_protected/db_encryption_key';
// Legacy SecureStore key — kept only for one-time read-on-migration.
const DB_KEY_LEGACY_SECURESTORE_KEY = 'tillit_db_encryption_key';

// SQLite database instance
let sqliteDb: SQLiteDatabase | null = null;

// Drizzle client instance
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Generate or retrieve the database encryption key from hardware-protected storage.
 * The key is a 64-char hex string (32 bytes).
 *
 * Migration: if a key exists in legacy SecureStore (`tillit_db_encryption_key`),
 * move it into the hardware-protected store and delete the SecureStore entry.
 */
async function getOrCreateDatabaseKey(): Promise<string> {
  // 1) Try hardware-protected store (canonical location)
  const protectedResult = await SignalProtocol.getProtectedData(DB_KEY_PROTECTED_KEY);
  if (protectedResult.data) {
    return base64ToHex(protectedResult.data);
  }

  // 2) Migration: SecureStore legacy → hardware-protected
  const legacy = await SecureStore.getItemAsync(DB_KEY_LEGACY_SECURESTORE_KEY);
  if (legacy) {
    const legacyHex = legacy;
    await SignalProtocol.setProtectedData(DB_KEY_PROTECTED_KEY, hexToBase64(legacyHex));
    await SecureStore.deleteItemAsync(DB_KEY_LEGACY_SECURESTORE_KEY);
    return legacyHex;
  }

  // 3) Fresh install: generate new 32-byte key
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  const hexKey = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await SignalProtocol.setProtectedData(DB_KEY_PROTECTED_KEY, hexToBase64(hexKey));
  return hexKey;
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToHex(b64: string): string {
  const binary = atob(b64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Create all tables if they don't exist (synchronous).
 * This always reflects the LATEST full schema — new installs get everything.
 */
function createTables(database: SQLiteDatabase) {
  database.execSync(`
    -- Servers table
    CREATE TABLE IF NOT EXISTS server (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_url TEXT NOT NULL,
      socket_url TEXT NOT NULL,
      socket_namespace TEXT NOT NULL DEFAULT '/chat',
      is_default INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      is_tor INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 1,
      created INTEGER DEFAULT (strftime('%s', 'now')),
      last_modified INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Messages table
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY NOT NULL,
      id_parent TEXT,
      type TEXT NOT NULL,
      id_room INTEGER NOT NULL,
      id_user_from INTEGER NOT NULL,
      id_user_to INTEGER,
      body TEXT NOT NULL,
      encrypted_body TEXT NOT NULL,
      id_status INTEGER NOT NULL,
      read INTEGER,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      expiry_datetime INTEGER,
      version TEXT NOT NULL,
      last_modified INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_message_room ON message(id_room);
    CREATE INDEX IF NOT EXISTS idx_message_timestamp ON message(timestamp);
    CREATE INDEX IF NOT EXISTS idx_message_parent ON message(id_parent);

    -- Rooms table
    CREATE TABLE IF NOT EXISTS room (
      id INTEGER PRIMARY KEY NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      id_user INTEGER NOT NULL,
      username TEXT,
      image TEXT,
      name TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 0,
      age INTEGER,
      timestamp_update INTEGER,
      timestamp_create INTEGER,
      last_modified INTEGER DEFAULT (strftime('%s', 'now')),
      use_sender_keys INTEGER NOT NULL DEFAULT 0,
      administered INTEGER NOT NULL DEFAULT 0,
      server_id INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_room_name ON room(name);
    CREATE INDEX IF NOT EXISTS idx_room_last_modified ON room(last_modified);
    CREATE INDEX IF NOT EXISTS idx_room_invite_code ON room(invite_code);

    -- Profiles table
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_user INTEGER NOT NULL,
      id_room INTEGER,
      username TEXT,
      image TEXT,
      last_modified INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_room_user_profile ON profile(id_user, id_room);

    -- Sessions table
    CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_user TEXT NOT NULL,
      id_room INTEGER NOT NULL,
      remote_user_name TEXT NOT NULL,
      remote_user_device_id INTEGER NOT NULL,
      created INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_modified INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_message_at INTEGER,
      identity_verified INTEGER NOT NULL DEFAULT 0,
      remote_known_devices TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_room_user_session ON session(id_user, id_room, remote_user_device_id);

    -- Identity table
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_modified INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_signed_pre_key_rotation INTEGER
    );

    -- Attachments table
    CREATE TABLE IF NOT EXISTS attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data TEXT NOT NULL,
      last_modified INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Sender Key Sessions table
    CREATE TABLE IF NOT EXISTS sender_key_session (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_room INTEGER NOT NULL,
      sender_user_id INTEGER NOT NULL,
      distribution_id TEXT NOT NULL,
      chain_version INTEGER NOT NULL DEFAULT 1,
      metadata TEXT,
      created INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_used INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_room_sender_session ON sender_key_session(id_room, sender_user_id);

    -- Sender Key Retry Queue table
    CREATE TABLE IF NOT EXISTS sender_key_retry_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      sender_user_id INTEGER NOT NULL,
      recipient_user_id INTEGER NOT NULL,
      distribution_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS unique_room_sender_recipient ON sender_key_retry_queue(room_id, sender_user_id, recipient_user_id);
  `);
}

// ============================================================================
// INCREMENTAL MIGRATIONS (PRAGMA user_version)
// ============================================================================

const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      'ALTER TABLE room ADD COLUMN administered INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    version: 2,
    statements: [
      'ALTER TABLE server ADD COLUMN is_tor INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    // Multi-device: expand `session` uniqueness to include the per-device
    // dimension so the primary can persist multiple sessions for the same
    // peer (one per remote deviceId) without overwriting. Fresh installs
    // already create the index with the 3-column shape in createTables();
    // this migration brings existing installs in line.
    version: 3,
    statements: [
      'DROP INDEX IF EXISTS unique_room_user_session',
      'CREATE UNIQUE INDEX IF NOT EXISTS unique_room_user_session ON session(id_user, id_room, remote_user_device_id)',
    ],
  },
  {
    // Multi-device cache refresh (frontend-0008): persist the peer device
    // list alongside each session row so the fan-out send path has a hot
    // cache at boot, without waiting for the first /keys/:userId refresh.
    version: 4,
    statements: [
      'ALTER TABLE session ADD COLUMN remote_known_devices TEXT',
    ],
  },
];

function applyMigrations(database: SQLiteDatabase) {
  const row = database.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;

  const latestVersion = MIGRATIONS.length > 0
    ? MIGRATIONS[MIGRATIONS.length - 1].version
    : 0;

  if (currentVersion >= latestVersion) return;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      for (const stmt of migration.statements) {
        try {
          database.execSync(stmt);
        } catch {
          // Column/table may already exist (fresh install) — ignore
        }
      }
    }
  }

  database.execSync(`PRAGMA user_version = ${latestVersion}`);
}

/**
 * Initialize the encrypted database.
 * MUST be called and succeed before any getDatabase() call.
 * Throws on failure — the app cannot start without a working DB.
 *
 * Flow:
 * 1. Generate/load encryption key from SecureStore
 * 2. Open database and apply PRAGMA key (first statement)
 * 3. Verify key works — if DB was unencrypted, delete and recreate
 * 4. Create tables + apply migrations
 */
export async function initDatabase(): Promise<void> {
  if (db) return;

  const key = await getOrCreateDatabaseKey();

  let database = openDatabaseSync(DATABASE_NAME);
  database.execSync(`PRAGMA key = "x'${key}'"`);

  // Verify the key works by querying sqlite_master
  try {
    database.getFirstSync<{ count: number }>('SELECT count(*) as count FROM sqlite_master');
  } catch {
    // Database exists but was not encrypted — delete and recreate
    try { database.closeSync(); } catch {}

    deleteDatabaseSync(DATABASE_NAME);

    database = openDatabaseSync(DATABASE_NAME);
    database.execSync(`PRAGMA key = "x'${key}'"`);
  }

  createTables(database);
  applyMigrations(database);
  sqliteDb = database;
  db = drizzle(database, { schema });
}

/**
 * Get the database instance.
 * initDatabase() MUST have been called first.
 */
export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Get the raw SQLite database for direct queries if needed.
 */
export function getSqliteDatabase() {
  if (!sqliteDb) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return sqliteDb;
}

/**
 * Close the database connection.
 */
export function closeDatabase() {
  if (sqliteDb) {
    sqliteDb.closeSync();
    sqliteDb = null;
    db = null;
  }
}

/**
 * Delete the SQLite file on disk and reset in-memory handles.
 *
 * Use this from "wipe and recreate" flows (e.g. fresh identity) where the
 * DB encryption key lives in hardware-protected storage that requires the
 * user to be authenticated. Re-opening the DB to truncate tables before
 * authentication is not possible — deleting the file instead achieves the
 * same outcome without needing the key.
 */
export function wipeDatabaseFiles(): void {
  if (sqliteDb) {
    try { sqliteDb.closeSync(); } catch {}
    sqliteDb = null;
    db = null;
  }
  try { deleteDatabaseSync(DATABASE_NAME); } catch {}
}

/**
 * @deprecated Use initDatabase() instead
 */
export async function initializeDatabase() {
  return initDatabase();
}

// Export the database type for use in other files
export type Database = ReturnType<typeof getDatabase>;
