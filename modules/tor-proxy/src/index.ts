import { NativeModule, requireNativeModule } from 'expo-modules-core';
import type {
  TorStatus,
  TorHttpRequestConfig,
  TorHttpResponse,
  TorStartResult,
  TorBootstrapEvent,
  TorWebSocketMessageEvent,
  TorWebSocketOpenEvent,
  TorWebSocketCloseEvent,
  TorWebSocketErrorEvent,
} from './TorProxy.types';

export type {
  TorStatus,
  TorHttpRequestConfig,
  TorHttpResponse,
  TorStartResult,
  TorBootstrapEvent,
  TorWebSocketMessageEvent,
  TorWebSocketOpenEvent,
  TorWebSocketCloseEvent,
  TorWebSocketErrorEvent,
};

interface TorProxyModuleInterface extends NativeModule {
  // Lifecycle
  start(): Promise<TorStartResult>;
  stop(): Promise<void>;
  getStatus(): TorStatus;
  getBootstrapProgress(): number;

  // HTTP via Tor (individual params — Expo Modules doesn't bridge [String: Any] well)
  httpRequest(url: string, method: string, headers: Record<string, string> | null, body: string | null, timeout: number | null): Promise<TorHttpResponse>;

  // WebSocket via Tor
  openWebSocket(url: string, protocols?: string[]): Promise<string>;
  sendWebSocket(wsId: string, data: string): Promise<void>;
  closeWebSocket(wsId: string, code?: number): Promise<void>;
}

const NativeTorProxy = requireNativeModule<TorProxyModuleInterface>('TorProxy');

export const TorProxy = {
  /**
   * Start the Tor daemon. Returns the SOCKS5 proxy port.
   */
  start(): Promise<TorStartResult> {
    return NativeTorProxy.start();
  },

  /**
   * Stop the Tor daemon.
   */
  stop(): Promise<void> {
    return NativeTorProxy.stop();
  },

  /**
   * Get the current Tor connection status.
   */
  getStatus(): TorStatus {
    return NativeTorProxy.getStatus();
  },

  /**
   * Get the bootstrap progress (0-100).
   */
  getBootstrapProgress(): number {
    return NativeTorProxy.getBootstrapProgress();
  },

  /**
   * Make an HTTP request via the Tor network.
   * Bypasses React Native's XMLHttpRequest — goes through native URLSession/OkHttp with SOCKS proxy.
   */
  httpRequest(config: TorHttpRequestConfig): Promise<TorHttpResponse> {
    return NativeTorProxy.httpRequest(
      config.url,
      config.method,
      config.headers ?? null,
      config.body ?? null,
      config.timeout ?? null,
    );
  },

  /**
   * Open a WebSocket connection via the Tor network.
   * Returns a websocket ID for subsequent send/close/event operations.
   */
  openWebSocket(url: string, protocols?: string[]): Promise<string> {
    return NativeTorProxy.openWebSocket(url, protocols);
  },

  /**
   * Send data on an open Tor WebSocket.
   */
  sendWebSocket(wsId: string, data: string): Promise<void> {
    return NativeTorProxy.sendWebSocket(wsId, data);
  },

  /**
   * Close a Tor WebSocket connection.
   */
  closeWebSocket(wsId: string, code?: number): Promise<void> {
    return NativeTorProxy.closeWebSocket(wsId, code);
  },

  /**
   * Access the native module directly for event subscriptions.
   * Events: onBootstrapProgress, onWebSocketMessage, onWebSocketOpen, onWebSocketClose, onWebSocketError
   */
  get events() {
    return NativeTorProxy;
  },
};

export default TorProxy;
