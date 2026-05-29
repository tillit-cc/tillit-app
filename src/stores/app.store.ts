import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Security alert for identity key changes
 */
export interface SecurityAlert {
  type: 'identity_key_changed';
  roomId: number;
  userId: number;
  message: string;
  timestamp: number;
}

export interface NotificationBannerData {
  roomId: number;
  roomName: string;
  senderName: string;
  messagePreview: string;
  messageType?: string;
  timestamp: number;
}

interface AppState {
  // Connection log (diagnostic)
  connectionLog: string[];

  // App state
  isInitialized: boolean;
  isInBackground: boolean;
  lastActiveTimestamp: number;

  // Security alerts
  securityAlerts: SecurityAlert[];

  // Notification banner
  notificationBanner: NotificationBannerData | null;

  // Deep link state
  pendingInviteCode: string | null;
  /** Pending multi-device pairing URL (tillit://link?v=2&i=...&s=...&e=...) — scanned by primary */
  pendingPrimaryScanLink: string | null;

  // Push notification state
  pendingNotificationRoomId: number | null;

  // Settings
  settings: {
    username: string;
    notificationsEnabled: boolean;
    soundEnabled: boolean;
    biometricEnabled: boolean;
    darkModeEnabled: boolean | null; // null = system default
  };

  // Connection log actions
  addConnectionLog: (message: string) => void;
  clearConnectionLog: () => void;

  // App state actions
  setInitialized: (initialized: boolean) => void;
  setInBackground: (inBackground: boolean) => void;
  updateLastActiveTimestamp: () => void;

  // Security alert actions
  addSecurityAlert: (alert: Omit<SecurityAlert, 'timestamp'>) => void;
  dismissSecurityAlert: (roomId: number, userId: number) => void;
  clearSecurityAlerts: () => void;

  // Notification banner actions
  showNotificationBanner: (data: NotificationBannerData) => void;
  dismissNotificationBanner: () => void;

  // Deep link actions
  setPendingInviteCode: (code: string | null) => void;
  setPendingPrimaryScanLink: (link: string | null) => void;

  // Push notification actions
  setPendingNotificationRoomId: (roomId: number | null) => void;

  // Settings actions
  updateSettings: (settings: Partial<AppState['settings']>) => void;

  // Selectors
  getSecurityAlertsForRoom: (roomId: number) => SecurityAlert[];
}

export const useAppStore = create<AppState>()(
  immer((set, get) => ({
    // Initial state
    connectionLog: [],
    isInitialized: false,
    isInBackground: false,
    lastActiveTimestamp: Date.now(),
    notificationBanner: null,
    pendingInviteCode: null,
    pendingPrimaryScanLink: null,
    pendingNotificationRoomId: null,
    securityAlerts: [],
    settings: {
      username: '',
      notificationsEnabled: true,
      soundEnabled: true,
      biometricEnabled: true,
      darkModeEnabled: null,
    },

    // Connection log actions
    addConnectionLog: (message) =>
      set((state) => {
        const timestamp = new Date().toLocaleTimeString();
        state.connectionLog.push(`[${timestamp}] ${message}`);

        // Keep only last 200 log entries
        if (state.connectionLog.length > 200) {
          state.connectionLog = state.connectionLog.slice(-200);
        }
      }),

    clearConnectionLog: () =>
      set((state) => {
        state.connectionLog = [];
      }),

    // App state actions
    setInitialized: (initialized) =>
      set((state) => {
        state.isInitialized = initialized;
      }),

    setInBackground: (inBackground) =>
      set((state) => {
        state.isInBackground = inBackground;
        if (!inBackground) {
          state.lastActiveTimestamp = Date.now();
        }
      }),

    updateLastActiveTimestamp: () =>
      set((state) => {
        state.lastActiveTimestamp = Date.now();
      }),

    // Security alert actions
    addSecurityAlert: (alert) =>
      set((state) => {
        // Check if alert already exists for this room+user
        const exists = state.securityAlerts.some(
          (a) => a.roomId === alert.roomId && a.userId === alert.userId
        );

        if (!exists) {
          state.securityAlerts.push({
            ...alert,
            timestamp: Date.now(),
          });
        }
      }),

    dismissSecurityAlert: (roomId, userId) =>
      set((state) => {
        state.securityAlerts = state.securityAlerts.filter(
          (a) => !(a.roomId === roomId && a.userId === userId)
        );
      }),

    clearSecurityAlerts: () =>
      set((state) => {
        state.securityAlerts = [];
      }),

    // Notification banner actions
    showNotificationBanner: (data) => {
      if (!data.messagePreview && !data.messageType) return;
      set((state) => {
        state.notificationBanner = data;
      });
    },

    dismissNotificationBanner: () =>
      set((state) => {
        state.notificationBanner = null;
      }),

    // Deep link actions
    setPendingInviteCode: (code) =>
      set((state) => {
        state.pendingInviteCode = code;
      }),

    setPendingPrimaryScanLink: (link) =>
      set((state) => {
        state.pendingPrimaryScanLink = link;
      }),

    // Push notification actions
    setPendingNotificationRoomId: (roomId) =>
      set((state) => {
        state.pendingNotificationRoomId = roomId;
      }),

    // Settings actions
    updateSettings: (settings) =>
      set((state) => {
        state.settings = { ...state.settings, ...settings };
      }),

    // Selectors
    getSecurityAlertsForRoom: (roomId) =>
      get().securityAlerts.filter((a) => a.roomId === roomId),
  }))
);
