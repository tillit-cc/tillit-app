// --- Mock dependencies BEFORE importing the module under test ---

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'ios', select: (obj: any) => obj.ios ?? obj.default },
  Appearance: {
    getColorScheme: jest.fn(() => 'light'),
    addChangeListener: jest.fn(() => ({ remove: jest.fn() })),
    // react-native-css-interop probes this during module init.
    isReduceMotionEnabled: jest.fn(() => false),
    addReduceMotionChangeListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  NativeModules: {},
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
  StyleSheet: { create: (obj: any) => obj, flatten: (s: any) => s },
}));

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US' }]),
  getCalendars: jest.fn(() => []),
}));

// db/client and the repositories pull in expo-sqlite → expo-modules-core →
// react-native-css-interop, which probes Appearance.isReduceMotionEnabled at
// import time. Bypassing the chain by stubbing the repos at module level
// matches the pattern used in src/services/__tests__/chat-*.test.ts.
jest.mock('@/db/client', () => ({
  getDatabase: jest.fn(() => ({})),
  initDatabase: jest.fn().mockResolvedValue(undefined),
  wipeDatabaseFiles: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/db/repositories/message.repository', () => ({
  messageRepository: {
    findStuckSending: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    deleteAll: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('signal-protocol', () => ({
  default: {
    lock: jest.fn(),
    isAuthenticated: jest.fn().mockReturnValue({ authenticated: true }),
  },
}));

const mockSocket = {
  onStateChange: jest.fn(() => jest.fn()),
  onAuthError: jest.fn(() => jest.fn()),
  getConnectionState: jest.fn(() => 0),
  connect: jest.fn().mockResolvedValue(undefined),
};

const mockApi = {
  getToken: jest.fn().mockResolvedValue('token'),
  clearToken: jest.fn().mockResolvedValue(undefined),
  registerPushToken: jest.fn().mockResolvedValue(undefined),
};

jest.mock('./server-registry', () => ({
  serverRegistry: {
    setAuthCallbacks: jest.fn(),
    loadServers: jest.fn().mockResolvedValue(undefined),
    ensureDefaultServer: jest.fn().mockResolvedValue(undefined),
    connectAll: jest.fn().mockResolvedValue(undefined),
    disconnectAll: jest.fn(),
    clearAll: jest.fn(),
    getAllServers: jest.fn(() => [{ id: 1 }]),
    getSocket: jest.fn(() => mockSocket),
    getApi: jest.fn(() => mockApi),
    getDefaultServerId: jest.fn(() => 1),
    onServerAdded: jest.fn(() => jest.fn()),
    reconnectServer: jest.fn().mockResolvedValue(undefined),
    hasAnyTorServer: jest.fn(() => false),
  },
}));

jest.mock('./chat.service', () => ({
  chatService: {
    init: jest.fn(),
    destroy: jest.fn(),
    recoverStuckMessages: jest.fn().mockResolvedValue(undefined),
    loadRooms: jest.fn().mockResolvedValue(undefined),
    registerSocketHandlers: jest.fn(),
  },
}));

jest.mock('./session.service', () => ({
  sessionService: {
    loadSessions: jest.fn().mockResolvedValue([]),
    initializePreKeyTracking: jest.fn().mockResolvedValue(undefined),
    refreshPreKeysIfNeeded: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/db/repositories/profile.repository', () => ({
  profileRepository: { findByUser: jest.fn().mockResolvedValue(null) },
}));

const mockSetBiometricAuthenticated = jest.fn();
const mockLogout = jest.fn();
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: {
    getState: jest.fn(() => ({
      isAuthenticated: true,
      userId: 42,
      isBiometricAuthenticated: true,
      setBiometricAuthenticated: mockSetBiometricAuthenticated,
      logout: mockLogout,
    })),
  },
}));

const mockSetInBackground = jest.fn();
const mockUpdateLastActiveTimestamp = jest.fn();
const mockUpdateSettings = jest.fn();
jest.mock('@/stores/app.store', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setInBackground: mockSetInBackground,
      updateLastActiveTimestamp: mockUpdateLastActiveTimestamp,
      updateSettings: mockUpdateSettings,
    })),
  },
}));

const mockClearAll = jest.fn();
jest.mock('@/stores/chat.store', () => ({
  useChatStore: { getState: jest.fn(() => ({ clearAll: mockClearAll })) },
}));

jest.mock('@/stores/server.store', () => ({
  useServerStore: {
    getState: jest.fn(() => ({
      setConnectionState: jest.fn(),
      isBanned: jest.fn(() => false),
      setBanned: jest.fn(),
    })),
  },
}));

jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  setDiagSink: jest.fn(),
}));

jest.mock('@/utils/image', () => ({
  deleteAllImages: jest.fn(),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'test-push-token' }),
  dismissAllNotificationsAsync: jest.fn().mockResolvedValue(undefined),
  setBadgeCountAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/db/repositories/server.repository', () => ({
  serverRepository: {
    findAll: jest.fn().mockResolvedValue([{ id: 1 }]),
  },
}));

// --- Now import the module under test and dependencies ---

import { appInitService } from './app-init.service';
import { serverRegistry } from './server-registry';
import { chatService } from './chat.service';
import { sessionService } from './session.service';

describe('AppInitService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset private state between tests
    (appInitService as any).initialized = false;
    (appInitService as any).appStateSubscription = null;
    (appInitService as any).unsubscribes = [];
  });

  // -------------------------------------------------------
  // 1. initialize: runs all 10 steps in order
  // -------------------------------------------------------
  describe('initialize — runs all bootstrap steps', () => {
    it('calls all 10 steps in the correct order', async () => {
      await appInitService.initialize();

      // Step 0: Load servers
      expect(serverRegistry.loadServers).toHaveBeenCalled();
      expect(serverRegistry.ensureDefaultServer).toHaveBeenCalled();

      // Step 1: Recover stuck messages
      expect(chatService.recoverStuckMessages).toHaveBeenCalled();

      // Step 2: Load Signal sessions
      expect(sessionService.loadSessions).toHaveBeenCalled();

      // Step 3: Init chat service
      expect(chatService.init).toHaveBeenCalled();

      // Step 4: Load rooms
      expect(chatService.loadRooms).toHaveBeenCalled();

      // Step 5: Pre-key tracking
      expect(sessionService.initializePreKeyTracking).toHaveBeenCalled();

      // Step 6: Load profile (profileRepository.findByUser called via loadProfile)
      const { profileRepository } = require('@/db/repositories/profile.repository');
      expect(profileRepository.findByUser).toHaveBeenCalledWith(42);

      // Step 7: Connect all sockets
      expect(serverRegistry.connectAll).toHaveBeenCalled();

      // Step 8: Refresh pre-keys (non-blocking)
      expect(sessionService.refreshPreKeysIfNeeded).toHaveBeenCalled();

      // Step 10: Setup lifecycle listeners
      const { AppState } = require('react-native');
      expect(AppState.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function),
      );

      // Verify call order: recoverStuck < loadSessions < init < loadRooms < preKeyTracking < connectAll
      const recoverOrder = (chatService.recoverStuckMessages as jest.Mock).mock.invocationCallOrder[0];
      const loadSessionsOrder = (sessionService.loadSessions as jest.Mock).mock.invocationCallOrder[0];
      const initOrder = (chatService.init as jest.Mock).mock.invocationCallOrder[0];
      const loadRoomsOrder = (chatService.loadRooms as jest.Mock).mock.invocationCallOrder[0];
      const preKeyOrder = (sessionService.initializePreKeyTracking as jest.Mock).mock.invocationCallOrder[0];
      const connectOrder = (serverRegistry.connectAll as jest.Mock).mock.invocationCallOrder[0];

      expect(recoverOrder).toBeLessThan(loadSessionsOrder);
      expect(loadSessionsOrder).toBeLessThan(initOrder);
      expect(initOrder).toBeLessThan(loadRoomsOrder);
      expect(loadRoomsOrder).toBeLessThan(preKeyOrder);
      expect(preKeyOrder).toBeLessThan(connectOrder);
    });
  });

  // -------------------------------------------------------
  // 2. initialize: sets initialized to true
  // -------------------------------------------------------
  describe('initialize — sets initialized flag', () => {
    it('sets initialized to true after bootstrap completes', async () => {
      expect(appInitService.isInitialized).toBe(false);

      await appInitService.initialize();

      expect(appInitService.isInitialized).toBe(true);
    });
  });

  // -------------------------------------------------------
  // 3. initialize: is idempotent (second call ensures sockets)
  // -------------------------------------------------------
  describe('initialize — idempotent', () => {
    it('second call skips bootstrap and only ensures socket connections', async () => {
      await appInitService.initialize();

      jest.clearAllMocks();

      await appInitService.initialize();

      // Bootstrap steps should NOT be called again
      expect(serverRegistry.loadServers).not.toHaveBeenCalled();
      expect(chatService.recoverStuckMessages).not.toHaveBeenCalled();
      expect(sessionService.loadSessions).not.toHaveBeenCalled();
      expect(chatService.init).not.toHaveBeenCalled();
      expect(chatService.loadRooms).not.toHaveBeenCalled();
      expect(sessionService.initializePreKeyTracking).not.toHaveBeenCalled();
      expect(serverRegistry.connectAll).not.toHaveBeenCalled();

      // ensureSocketsConnected is called — it iterates servers
      expect(serverRegistry.getAllServers).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // 4. initialize: step failure doesn't block subsequent steps
  // -------------------------------------------------------
  describe('initialize — step failure resilience', () => {
    it('continues to subsequent steps when an early step throws', async () => {
      // Make Step 1 (recoverStuckMessages) fail
      (chatService.recoverStuckMessages as jest.Mock).mockRejectedValueOnce(
        new Error('crash recovery failed'),
      );

      // Make Step 2 (loadSessions) fail
      (sessionService.loadSessions as jest.Mock).mockRejectedValueOnce(
        new Error('session DB corrupt'),
      );

      await appInitService.initialize();

      // Despite step 1 and 2 failing, subsequent steps should still run
      expect(chatService.init).toHaveBeenCalled(); // Step 3
      expect(chatService.loadRooms).toHaveBeenCalled(); // Step 4
      expect(sessionService.initializePreKeyTracking).toHaveBeenCalled(); // Step 5
      expect(serverRegistry.connectAll).toHaveBeenCalled(); // Step 7

      // Should still mark as initialized
      expect(appInitService.isInitialized).toBe(true);
    });
  });

  // -------------------------------------------------------
  // 5. destroy: calls chatService.destroy and serverRegistry.clearAll
  // -------------------------------------------------------
  describe('destroy — teardown', () => {
    it('calls chatService.destroy and serverRegistry.clearAll', async () => {
      await appInitService.initialize();

      appInitService.destroy();

      expect(chatService.destroy).toHaveBeenCalled();
      expect(serverRegistry.clearAll).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // 6. destroy: sets initialized to false
  // -------------------------------------------------------
  describe('destroy — resets initialized', () => {
    it('sets initialized to false after destroy', async () => {
      await appInitService.initialize();
      expect(appInitService.isInitialized).toBe(true);

      appInitService.destroy();

      expect(appInitService.isInitialized).toBe(false);
    });
  });

  // -------------------------------------------------------
  // 7. logout: disconnects, clears tokens, resets stores
  // -------------------------------------------------------
  describe('logout — full cleanup', () => {
    it('disconnects sockets, clears tokens, and resets stores', async () => {
      await appInitService.initialize();

      jest.clearAllMocks();

      await appInitService.logout();

      // Disconnects all sockets and clears service instances
      expect(chatService.destroy).toHaveBeenCalled();
      expect(serverRegistry.clearAll).toHaveBeenCalled();

      // Clears token via SecureStore
      const SecureStore = require('expo-secure-store');
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('token_server_1');

      // Resets stores
      expect(mockClearAll).toHaveBeenCalled(); // useChatStore.clearAll
      expect(mockLogout).toHaveBeenCalled(); // useAuthStore.logout

      // Sets initialized to false
      expect(appInitService.isInitialized).toBe(false);
    });
  });

  // -------------------------------------------------------
  // 8. isInitialized: returns correct value
  // -------------------------------------------------------
  describe('isInitialized — getter', () => {
    it('returns false before initialize', () => {
      expect(appInitService.isInitialized).toBe(false);
    });

    it('returns true after initialize', async () => {
      await appInitService.initialize();
      expect(appInitService.isInitialized).toBe(true);
    });

    it('returns false after destroy', async () => {
      await appInitService.initialize();
      appInitService.destroy();
      expect(appInitService.isInitialized).toBe(false);
    });

    it('returns false after logout', async () => {
      await appInitService.initialize();
      await appInitService.logout();
      expect(appInitService.isInitialized).toBe(false);
    });
  });
});
