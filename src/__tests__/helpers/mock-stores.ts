/**
 * Factory functions for mocking Zustand stores.
 * Each factory returns a mock state with jest.fn() actions.
 */

export function createMockAuthStoreState(overrides: Record<string, any> = {}) {
  return {
    isAuthenticated: true,
    userId: 42,
    isBiometricAuthenticated: true,
    identityState: 'found' as const,
    setBiometricAuthenticated: jest.fn(),
    logout: jest.fn(),
    ...overrides,
  };
}

export function createMockAppStoreState(overrides: Record<string, any> = {}) {
  return {
    isInitialized: true,
    isInBackground: false,
    connectionLog: [],
    securityAlerts: [],
    pendingInviteCode: null,
    pendingNotificationRoomId: null,
    settings: { username: 'testuser', notifications: true, sound: true, biometric: true, darkMode: false },
    addConnectionLog: jest.fn(),
    setInBackground: jest.fn(),
    addSecurityAlert: jest.fn(),
    updateSettings: jest.fn(),
    updateLastActiveTimestamp: jest.fn(),
    setPendingInviteCode: jest.fn(),
    ...overrides,
  };
}

export function createMockChatStoreState(overrides: Record<string, any> = {}) {
  return {
    currentRoomId: null as number | null,
    messages: new Map<number, any[]>(),
    allRooms: [] as any[],
    profiles: new Map<number, any[]>(),
    addMessage: jest.fn(),
    updateMessage: jest.fn(),
    removeMessage: jest.fn(),
    setMessages: jest.fn(),
    prependMessages: jest.fn(),
    replaceMessageId: jest.fn(),
    addRoomToList: jest.fn(),
    updateRoomInList: jest.fn(),
    removeRoomFromList: jest.fn(),
    clearRoom: jest.fn(),
    clearAll: jest.fn(),
    setAllRooms: jest.fn(),
    setProfiles: jest.fn(),
    updateProfile: jest.fn(),
    setTyping: jest.fn(),
    setPaginationState: jest.fn(),
    ...overrides,
  };
}

export function createMockServerStoreState(overrides: Record<string, any> = {}) {
  return {
    servers: [],
    connectionStates: new Map(),
    reconnectAttempts: new Map(),
    setServers: jest.fn(),
    addServer: jest.fn(),
    removeServer: jest.fn(),
    updateServer: jest.fn(),
    setConnectionState: jest.fn(),
    setReconnectAttempts: jest.fn(),
    isAnyConnected: jest.fn().mockReturnValue(false),
    isAnyConnecting: jest.fn().mockReturnValue(false),
    getConnectionState: jest.fn().mockReturnValue(0),
    getReconnectAttempts: jest.fn().mockReturnValue(0),
    ...overrides,
  };
}
