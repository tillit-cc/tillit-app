import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { SocketConnectionState } from '@/types/connection';
import { Server } from '@/db/schema';

// Ensure MapSet plugin is enabled (may already be from chat.store)
enableMapSet();

interface ServerState {
  servers: Server[];
  connectionStates: Map<number, SocketConnectionState>;
  reconnectAttempts: Map<number, number>;
  bannedServers: Set<number>;
  /**
   * ADR-0011 liveness lock: servers that rejected this (linked) device with
   * `PRIMARY_INACTIVE` because the primary has been idle too long. TEMPORARY
   * and REVERSIBLE — cleared automatically on the next successful connect once
   * the primary is back online. Surfaced as a badge, never a logout.
   */
  primaryInactiveServers: Set<number>;

  // Actions
  setServers: (servers: Server[]) => void;
  addServer: (server: Server) => void;
  removeServer: (serverId: number) => void;
  updateServer: (serverId: number, updates: Partial<Server>) => void;
  setConnectionState: (serverId: number, state: SocketConnectionState) => void;
  setReconnectAttempts: (serverId: number, attempts: number) => void;
  setBanned: (serverId: number, banned: boolean) => void;
  setPrimaryInactive: (serverId: number, inactive: boolean) => void;

  // Selectors
  isAnyConnected: () => boolean;
  isAnyConnecting: () => boolean;
  getConnectionState: (serverId: number) => SocketConnectionState;
  getReconnectAttempts: (serverId: number) => number;
  isBanned: (serverId: number) => boolean;
  isPrimaryInactive: (serverId: number) => boolean;
}

export const useServerStore = create<ServerState>()(
  immer((set, get) => ({
    servers: [],
    connectionStates: new Map(),
    reconnectAttempts: new Map(),
    bannedServers: new Set(),
    primaryInactiveServers: new Set(),

    setServers: (servers) =>
      set((state) => {
        state.servers = servers;
      }),

    addServer: (server) =>
      set((state) => {
        state.servers.push(server);
      }),

    removeServer: (serverId) =>
      set((state) => {
        state.servers = state.servers.filter((s) => s.id !== serverId);
        state.connectionStates.delete(serverId);
        state.reconnectAttempts.delete(serverId);
        state.bannedServers.delete(serverId);
        state.primaryInactiveServers.delete(serverId);
      }),

    updateServer: (serverId, updates) =>
      set((state) => {
        const index = state.servers.findIndex((s) => s.id === serverId);
        if (index !== -1) {
          state.servers[index] = { ...state.servers[index], ...updates };
        }
      }),

    setConnectionState: (serverId, connectionState) =>
      set((state) => {
        state.connectionStates.set(serverId, connectionState);
        if (connectionState === SocketConnectionState.CONNECTED) {
          state.reconnectAttempts.set(serverId, 0);
        }
      }),

    setReconnectAttempts: (serverId, attempts) =>
      set((state) => {
        state.reconnectAttempts.set(serverId, attempts);
      }),

    setBanned: (serverId, banned) =>
      set((state) => {
        if (banned) {
          state.bannedServers.add(serverId);
        } else {
          state.bannedServers.delete(serverId);
        }
      }),

    setPrimaryInactive: (serverId, inactive) =>
      set((state) => {
        if (inactive) {
          state.primaryInactiveServers.add(serverId);
        } else {
          state.primaryInactiveServers.delete(serverId);
        }
      }),

    isAnyConnected: () => {
      const states = get().connectionStates;
      for (const state of states.values()) {
        if (state === SocketConnectionState.CONNECTED) return true;
      }
      return false;
    },

    isAnyConnecting: () => {
      const states = get().connectionStates;
      for (const state of states.values()) {
        if (state === SocketConnectionState.CONNECTING) return true;
      }
      return false;
    },

    getConnectionState: (serverId) => {
      return get().connectionStates.get(serverId) ?? SocketConnectionState.CLOSED;
    },

    getReconnectAttempts: (serverId) => {
      return get().reconnectAttempts.get(serverId) ?? 0;
    },

    isBanned: (serverId) => {
      return get().bannedServers.has(serverId);
    },

    isPrimaryInactive: (serverId) => {
      return get().primaryInactiveServers.has(serverId);
    },
  }))
);
