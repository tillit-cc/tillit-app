export type TorStatus = 'stopped' | 'connecting' | 'bootstrapping' | 'connected';

export interface TorHttpRequestConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface TorHttpResponse {
  status: number;
  data: string;
  headers: Record<string, string>;
}

export interface TorStartResult {
  socksPort: number;
}

export interface TorBootstrapEvent {
  progress: number;
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
  error: string;
}
