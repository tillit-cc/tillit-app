import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { Message, Room, Profile } from '@/db/schema';
import { TYPING_EXPIRE_MS, TYPING_CLEANUP_INTERVAL_MS } from '@/config/app.config';
import { UserMessageTypeValue } from '@/types/message';

// Enable Immer's MapSet plugin for Map/Set support in store
enableMapSet();

/**
 * Message metadata for UI optimization
 */
export interface MessageMetadata {
  showHeader: boolean;
  showDateSeparator: boolean;
  username: string | false;
  time: string;
  dateText: string;
}

/**
 * Pagination state for a room
 */
export interface PaginationState {
  hasMore: boolean;
  oldestTimestamp: number | null;
  isLoadingMore: boolean;
}

/**
 * Room with computed fields
 */
export interface RoomWithMetadata extends Room {
  serverId: number;
  lastMessageTime?: number | null;
  lastMessageText?: string;
  lastMessageType?: UserMessageTypeValue | string;
  unreadCount?: number;
  hasSession?: boolean;
}

const MAX_MESSAGES_IN_MEMORY = 200;

// Module-level date cache — NOT managed by Immer to avoid freeze errors
const dateCache = new Map<number, { dateObj: Date; day: number; month: number; year: number }>();

// --- Message batching ---
// Buffers addMessage calls and flushes them in a single store update.
// Uses a debounced setTimeout: each new message resets the timer so that
// messages arriving in rapid succession (e.g. 10 messages after reconnect,
// each decrypted sequentially ~50-100ms apart) are batched into a single
// store update instead of causing 10 individual re-renders.
const BATCH_FLUSH_DELAY_MS = 150;

let pendingAddMessages: Map<number, Message[]> = new Map();
let batchTimeoutId: ReturnType<typeof setTimeout> | null = null;

function scheduleBatchFlush() {
  if (batchTimeoutId !== null) {
    clearTimeout(batchTimeoutId);
  }
  batchTimeoutId = setTimeout(() => {
    batchTimeoutId = null;
    const batch = pendingAddMessages;
    pendingAddMessages = new Map();
    if (batch.size === 0) return;

    useChatStore.getState()._flushMessageBatch(batch);
  }, BATCH_FLUSH_DELAY_MS);
}

// Module-level typing cleanup timer — single instance, auto-managed
let typingCleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureTypingCleanupRunning() {
  if (typingCleanupTimer) return;
  typingCleanupTimer = setInterval(() => {
    const store = useChatStore.getState();
    store.clearStaleTyping();
    // Stop timer when no one is typing
    if (store.typingUsers.size === 0 && typingCleanupTimer) {
      clearInterval(typingCleanupTimer);
      typingCleanupTimer = null;
    }
  }, TYPING_CLEANUP_INTERVAL_MS);
}

interface ChatState {
  // Current room state
  currentRoomId: number | null;
  currentUserId: number | null;

  // Data maps
  messages: Map<number, Message[]>;
  profiles: Map<number, Map<number, Profile>>;
  rooms: Map<number, RoomWithMetadata>;
  allRooms: RoomWithMetadata[];
  paginationState: Map<number, PaginationState>;
  typingUsers: Map<number, Map<number, number>>; // roomId → userId → timestamp

  // Actions - Room
  setCurrentRoom: (roomId: number | null) => void;
  setCurrentUserId: (userId: number | null) => void;
  setRoom: (room: RoomWithMetadata) => void;
  updateRoom: (roomId: number, updates: Partial<RoomWithMetadata>) => void;
  deleteRoom: (roomId: number) => void;
  setAllRooms: (rooms: RoomWithMetadata[]) => void;
  addRoomToList: (room: RoomWithMetadata) => void;
  updateRoomInList: (roomId: number, updates: Partial<RoomWithMetadata>) => void;
  removeRoomFromList: (roomId: number) => void;

  // Actions - Messages
  setMessages: (roomId: number, messages: Message[]) => void;
  addMessage: (roomId: number, message: Message) => void;
  _flushMessageBatch: (batch: Map<number, Message[]>) => void;
  prependMessages: (roomId: number, messages: Message[]) => void;
  updateMessage: (roomId: number, messageId: string, updates: Partial<Message>) => void;
  replaceMessageId: (roomId: number, oldId: string, newId: string, updates?: Partial<Message>) => void;
  removeMessage: (roomId: number, messageId: string) => void;
  swapMessage: (roomId: number, oldMessageId: string, newMessage: Message) => void;

  // Actions - Profiles
  setProfiles: (roomId: number, profiles: Profile[]) => void;
  updateProfile: (roomId: number, userId: number, updates: Partial<Profile>) => void;
  removeProfile: (roomId: number, userId: number) => void;

  // Actions - Pagination
  setPaginationState: (roomId: number, state: Partial<PaginationState>) => void;

  // Actions - Typing
  setTyping: (roomId: number, userId: number, isTyping: boolean) => void;
  clearStaleTyping: () => void;

  // Actions - Cleanup
  clearRoom: (roomId: number) => void;
  clearAll: () => void;

  // Selectors
  getCurrentRoomMessages: () => Message[];
  getCurrentRoomProfiles: () => Map<number, Profile>;
  getCurrentRoom: () => RoomWithMetadata | null;
  getSortedRooms: () => RoomWithMetadata[];
  getMessageMetadata: () => Map<string, MessageMetadata>;
}

export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    // Initial state
    currentRoomId: null,
    currentUserId: null,
    messages: new Map(),
    profiles: new Map(),
    rooms: new Map(),
    allRooms: [],
    paginationState: new Map(),
    typingUsers: new Map(),

    // Room actions
    setCurrentRoom: (roomId) =>
      set((state) => {
        state.currentRoomId = roomId;
      }),

    setCurrentUserId: (userId) =>
      set((state) => {
        state.currentUserId = userId;
      }),

    setRoom: (room) =>
      set((state) => {
        state.rooms.set(room.id, room);
      }),

    updateRoom: (roomId, updates) =>
      set((state) => {
        const existing = state.rooms.get(roomId);
        if (existing) {
          state.rooms.set(roomId, { ...existing, ...updates });
        }
      }),

    deleteRoom: (roomId) =>
      set((state) => {
        state.rooms.delete(roomId);
        state.messages.delete(roomId);
        state.profiles.delete(roomId);
        state.paginationState.delete(roomId);
      }),

    setAllRooms: (rooms) =>
      set((state) => {
        state.allRooms = rooms;
        rooms.forEach((room) => state.rooms.set(room.id, room));
      }),

    addRoomToList: (room) =>
      set((state) => {
        state.allRooms.push(room);
        state.rooms.set(room.id, room);
      }),

    updateRoomInList: (roomId, updates) =>
      set((state) => {
        const index = state.allRooms.findIndex((r) => r.id === roomId);
        if (index !== -1) {
          state.allRooms[index] = { ...state.allRooms[index], ...updates };
        }
        const existing = state.rooms.get(roomId);
        if (existing) {
          state.rooms.set(roomId, { ...existing, ...updates });
        }
      }),

    removeRoomFromList: (roomId) =>
      set((state) => {
        state.allRooms = state.allRooms.filter((r) => r.id !== roomId);
        state.rooms.delete(roomId);
      }),

    // Message actions
    setMessages: (roomId, messages) =>
      set((state) => {
        // Drain any pending batch messages for this room to prevent
        // a subsequent rAF flush from losing messages that arrived
        // between the DB query start and this setMessages call.
        const pendingForRoom = pendingAddMessages.get(roomId);
        if (pendingForRoom && pendingForRoom.length > 0) {
          const loadedIds = new Set(messages.map((m) => m.id));
          const extra = pendingForRoom.filter((m) => !loadedIds.has(m.id));
          if (extra.length > 0) {
            messages = [...messages, ...extra];
          }
          pendingAddMessages.delete(roomId);
        }
        state.messages.set(roomId, messages);
      }),

    addMessage: (roomId, message) => {
      const pending = pendingAddMessages.get(roomId) || [];
      pending.push(message);
      pendingAddMessages.set(roomId, pending);
      scheduleBatchFlush();
    },

    _flushMessageBatch: (batch) =>
      set((state) => {
        for (const [roomId, messages] of batch) {
          const existing = state.messages.get(roomId) || [];
          // Deduplicate by id
          const existingIds = new Set(existing.map((m) => m.id));
          const newOnes = messages.filter((m) => !existingIds.has(m.id));
          if (newOnes.length === 0) continue;

          let merged = [...existing, ...newOnes];

          // Trim if exceeds limit
          if (merged.length > MAX_MESSAGES_IN_MEMORY) {
            const trimCount = merged.length - MAX_MESSAGES_IN_MEMORY;
            merged = merged.slice(trimCount);
          }

          state.messages.set(roomId, merged);
        }
      }),

    prependMessages: (roomId, messages) =>
      set((state) => {
        const existing = state.messages.get(roomId) || [];
        let combined = [...messages, ...existing];

        // Trim newest if exceeds limit
        if (combined.length > MAX_MESSAGES_IN_MEMORY) {
          combined = combined.slice(0, MAX_MESSAGES_IN_MEMORY);
        }

        state.messages.set(roomId, combined);
      }),

    updateMessage: (roomId, messageId, updates) => {
      // Check pending batch first (message may not be flushed to store yet)
      const pending = pendingAddMessages.get(roomId);
      if (pending) {
        const pi = pending.findIndex((m) => m.id === messageId);
        if (pi !== -1) {
          pending[pi] = { ...pending[pi], ...updates };
          return;
        }
      }
      set((state) => {
        const messages = state.messages.get(roomId);
        if (!messages) return;
        const index = messages.findIndex((m) => m.id === messageId);
        if (index !== -1) {
          const updated = [...messages];
          updated[index] = { ...messages[index], ...updates };
          state.messages.set(roomId, updated);
        }
      });
    },

    replaceMessageId: (roomId, oldId, newId, updates) => {
      // Check pending batch first
      const pending = pendingAddMessages.get(roomId);
      if (pending) {
        const pi = pending.findIndex((m) => m.id === oldId);
        if (pi !== -1) {
          pending[pi] = { ...pending[pi], ...updates, id: newId };
          return;
        }
      }
      set((state) => {
        const msgs = state.messages.get(roomId);
        if (!msgs) return;
        const index = msgs.findIndex((m) => m.id === oldId);
        if (index !== -1) {
          const updated = [...msgs];
          updated[index] = { ...msgs[index], ...updates, id: newId };
          state.messages.set(roomId, updated);
        }
      });
    },

    removeMessage: (roomId, messageId) =>
      set((state) => {
        const messages = state.messages.get(roomId) || [];
        state.messages.set(
          roomId,
          messages.filter((m) => m.id !== messageId)
        );
      }),

    swapMessage: (roomId, oldMessageId, newMessage) =>
      set((state) => {
        const messages = state.messages.get(roomId) || [];
        const filtered = messages.filter((m) => m.id !== oldMessageId);
        state.messages.set(roomId, [...filtered, newMessage]);
      }),

    // Profile actions
    setProfiles: (roomId, profiles) =>
      set((state) => {
        const profileMap = new Map<number, Profile>();
        profiles.forEach((p) => profileMap.set(p.idUser, p));
        state.profiles.set(roomId, profileMap);
      }),

    updateProfile: (roomId, userId, updates) =>
      set((state) => {
        const roomProfiles = state.profiles.get(roomId) || new Map();
        const existing = roomProfiles.get(userId);

        if (existing) {
          roomProfiles.set(userId, { ...existing, ...updates });
        } else {
          roomProfiles.set(userId, {
            idUser: userId,
            idRoom: roomId,
            username: updates.username ?? null,
            ...updates,
          } as Profile);
        }

        state.profiles.set(roomId, roomProfiles);
      }),

    removeProfile: (roomId, userId) =>
      set((state) => {
        const roomProfiles = state.profiles.get(roomId);
        if (roomProfiles) {
          roomProfiles.delete(userId);
        }
      }),

    // Pagination actions
    setPaginationState: (roomId, state) =>
      set((draft) => {
        const current = draft.paginationState.get(roomId) || {
          hasMore: false,
          oldestTimestamp: null,
          isLoadingMore: false,
        };
        draft.paginationState.set(roomId, { ...current, ...state });
      }),

    // Typing actions
    setTyping: (roomId, userId, isTyping) => {
      set((state) => {
        if (isTyping) {
          let roomTyping = state.typingUsers.get(roomId);
          if (!roomTyping) {
            roomTyping = new Map();
            state.typingUsers.set(roomId, roomTyping);
          }
          roomTyping.set(userId, Date.now());
        } else {
          const roomTyping = state.typingUsers.get(roomId);
          if (roomTyping) {
            roomTyping.delete(userId);
            if (roomTyping.size === 0) {
              state.typingUsers.delete(roomId);
            }
          }
        }
      });
      if (isTyping) ensureTypingCleanupRunning();
    },

    clearStaleTyping: () =>
      set((state) => {
        const now = Date.now();
        for (const [roomId, roomTyping] of state.typingUsers) {
          for (const [userId, ts] of roomTyping) {
            if (now - ts > TYPING_EXPIRE_MS) {
              roomTyping.delete(userId);
            }
          }
          if (roomTyping.size === 0) {
            state.typingUsers.delete(roomId);
          }
        }
      }),

    // Cleanup actions
    clearRoom: (roomId) =>
      set((state) => {
        state.messages.delete(roomId);
        state.profiles.delete(roomId);
        state.rooms.delete(roomId);
        state.paginationState.delete(roomId);
      }),

    clearAll: () => {
      dateCache.clear();
      set((state) => {
        state.currentRoomId = null;
        state.currentUserId = null;
        state.messages.clear();
        state.profiles.clear();
        state.rooms.clear();
        state.allRooms = [];
        state.paginationState.clear();
        state.typingUsers.clear();
      });
    },

    // Selectors
    getCurrentRoomMessages: () => {
      const state = get();
      if (!state.currentRoomId) return [];
      return state.messages.get(state.currentRoomId) || [];
    },

    getCurrentRoomProfiles: () => {
      const state = get();
      if (!state.currentRoomId) return new Map();
      return state.profiles.get(state.currentRoomId) || new Map();
    },

    getCurrentRoom: () => {
      const state = get();
      if (!state.currentRoomId) return null;
      return state.rooms.get(state.currentRoomId) || null;
    },

    getSortedRooms: () => {
      const state = get();
      return [...state.allRooms].sort((a, b) => {
        const timeA = a.lastMessageTime || a.timestampCreate || 0;
        const timeB = b.lastMessageTime || b.timestampCreate || 0;
        return timeB - timeA;
      });
    },

    getMessageMetadata: () => {
      const state = get();
      const messages = state.getCurrentRoomMessages();
      const profiles = state.getCurrentRoomProfiles();
      const currentUserId = state.currentUserId;
      const memberCount = profiles.size;

      if (messages.length === 0) {
        return new Map<string, MessageMetadata>();
      }

      return computeMessageMetadata(messages, profiles, currentUserId, memberCount, dateCache);
    },
  }))
);

/**
 * Compute message metadata for a list of messages.
 * Messages MUST be in ASC order (oldest first).
 * Uses module-level dateCache for performance.
 */
export function buildMessageMetadata(
  messages: Message[],
  profiles: Map<number, Profile>,
  currentUserId: number | null,
): Map<string, MessageMetadata> {
  if (messages.length === 0) return new Map();
  return computeMessageMetadata(messages, profiles, currentUserId, profiles.size, dateCache);
}

// Internal helper functions
function computeMessageMetadata(
  messages: Message[],
  profiles: Map<number, Profile>,
  currentUserId: number | null,
  memberCount: number,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
): Map<string, MessageMetadata> {
  const metadata = new Map<string, MessageMetadata>();

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;

    const showDateSeparator = shouldShowDateSeparator(current, prev, dateCache);
    const showHeader = shouldShowHeader(current, prev, dateCache);

    metadata.set(current.id, {
      showHeader,
      showDateSeparator,
      username: getUsername(current.idUserFrom, currentUserId, memberCount, profiles),
      time: formatTime(current.timestamp),
      dateText: showDateSeparator ? formatDate(current.timestamp, dateCache) : '',
    });
  }

  return metadata;
}

function shouldShowHeader(
  current: Message,
  prev: Message | null,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
): boolean {
  if (!prev) return true;

  const timeDiff = timestampToMs(current.timestamp) - timestampToMs(prev.timestamp);
  const isDifferentUser = current.idUserFrom !== prev.idUserFrom;
  const isMoreThan5Min = timeDiff > 300000;
  const isDifferentDay = !isSameDay(current.timestamp, prev.timestamp, dateCache);

  return isDifferentUser || isMoreThan5Min || isDifferentDay;
}

function shouldShowDateSeparator(
  current: Message,
  prev: Message | null,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
): boolean {
  if (!prev) return true;
  return !isSameDay(current.timestamp, prev.timestamp, dateCache);
}

function getUsername(
  userId: number,
  currentUserId: number | null,
  memberCount: number,
  profiles: Map<number, Profile>
): string | false {
  if (userId === currentUserId || memberCount <= 2) {
    return false;
  }

  const profile = profiles.get(userId);
  return profile?.username || `User ${userId}`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestampToMs(timestamp));
  return date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDate(
  timestamp: number,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
): string {
  const cached = getCachedDate(timestamp, dateCache);
  const date = cached.dateObj;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (
    cached.year === today.getFullYear() &&
    cached.month === today.getMonth() &&
    cached.day === today.getDate()
  ) {
    return 'Oggi';
  }

  if (
    cached.year === yesterday.getFullYear() &&
    cached.month === yesterday.getMonth() &&
    cached.day === yesterday.getDate()
  ) {
    return 'Ieri';
  }

  return date.toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function isSameDay(
  timestamp1: number,
  timestamp2: number,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
): boolean {
  const date1 = getCachedDate(timestamp1, dateCache);
  const date2 = getCachedDate(timestamp2, dateCache);

  return date1.year === date2.year && date1.month === date2.month && date1.day === date2.day;
}

function getCachedDate(
  timestamp: number,
  dateCache: Map<number, { dateObj: Date; day: number; month: number; year: number }>
) {
  const key = timestampToMs(timestamp);

  if (dateCache.has(key)) {
    return dateCache.get(key)!;
  }

  const date = new Date(key);
  const cached = {
    dateObj: date,
    day: date.getDate(),
    month: date.getMonth(),
    year: date.getFullYear(),
  };

  dateCache.set(key, cached);
  return cached;
}

function timestampToMs(timestamp: number): number {
  return timestamp > 10000000000 ? timestamp : timestamp * 1000;
}
