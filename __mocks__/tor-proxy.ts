// Jest mock for the `tor-proxy` native module. The real module uses ESM-style
// imports and a native binding that Jest cannot transform / load. Tests that
// reach api.service / socket.service indirectly pull this in via the Tor
// adapter / websocket transport — provide stubs so the require chain resolves.

export const TorProxy = {
  start: jest.fn().mockResolvedValue({ socksPort: 9050 }),
  stop: jest.fn().mockResolvedValue(undefined),
  getStatus: jest.fn().mockResolvedValue('stopped'),
  getBootstrapProgress: jest.fn().mockResolvedValue(0),
  httpRequest: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: '' }),
  openWebSocket: jest.fn().mockResolvedValue('mock-ws-id'),
  sendWebSocket: jest.fn().mockResolvedValue(undefined),
  closeWebSocket: jest.fn().mockResolvedValue(undefined),
  events: {
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
  },
};

export const TorStatus = {
  Stopped: 'stopped',
  Connecting: 'connecting',
  Bootstrapping: 'bootstrapping',
  Connected: 'connected',
} as const;

export type TorStatusType = (typeof TorStatus)[keyof typeof TorStatus];

export interface TorHttpRequestConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface TorWebSocketMessageEvent {
  wsId: string;
  data: string;
}

export interface TorWebSocketOpenEvent {
  wsId: string;
}

export interface TorWebSocketCloseEvent {
  wsId: string;
  code: number;
  reason: string;
}

export interface TorWebSocketErrorEvent {
  wsId: string;
  message: string;
}

export default TorProxy;
