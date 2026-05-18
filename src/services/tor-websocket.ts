import { TorProxy } from 'tor-proxy';
import type {
  TorWebSocketMessageEvent,
  TorWebSocketOpenEvent,
  TorWebSocketCloseEvent,
  TorWebSocketErrorEvent,
} from 'tor-proxy';
import { logger } from '@/utils/logger';

/**
 * WebSocket-compatible class that routes traffic through the Tor SOCKS5 proxy.
 *
 * Socket.IO v4 accepts a custom WebSocket constructor via `opts.webSocket`.
 * This class bridges Socket.IO's WebSocket API to TorProxy's native SOCKS5 WebSocket.
 *
 * The native module does: TCP→SOCKS5→HTTP Upgrade→RFC 6455 frames.
 * This JS class translates native events to the standard WebSocket interface.
 */
export class TorWebSocket {
  // WebSocket standard constants
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = 0;
  url: string;
  protocol: string = '';
  extensions: string = '';
  bufferedAmount: number = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';

  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  private wsId: string | null = null;
  private pendingWsId: Promise<string>;
  private subscriptions: (() => void)[] = [];
  // Buffer events that arrive before wsId is set
  private pendingEvents: Array<{ type: string; event: any }> = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.readyState = this.CONNECTING;

    const protocolArray = protocols
      ? Array.isArray(protocols) ? protocols : [protocols]
      : undefined;

    logger.info('[TorWebSocket] Connecting to Tor WebSocket');

    // Subscribe to ALL events (not filtered by wsId yet — we'll filter when processing)
    this.setupEventListeners();

    // Open the native WebSocket — store the promise so we can await the ID
    this.pendingWsId = TorProxy.openWebSocket(url, protocolArray);

    this.pendingWsId
      .then((id: string) => {
        this.wsId = id;
        // Process any buffered events that arrived before we got the ID
        this.flushPendingEvents();
      })
      .catch((error: any) => {
        logger.error(`[TorWebSocket] Failed to open: ${error?.message || error}`);
        this.readyState = this.CLOSED;
        this.onerror?.({ type: 'error', message: error?.message || String(error) });
        this.onclose?.({ type: 'close', code: 1006, reason: error?.message || 'Connection failed', wasClean: false });
        this.cleanup();
      });
  }

  send(data: string | ArrayBuffer | Blob): void {
    if (this.readyState !== this.OPEN) {
      throw new Error('WebSocket is not open');
    }
    if (!this.wsId) return;

    const strData = typeof data === 'string' ? data : String(data);
    TorProxy.sendWebSocket(this.wsId, strData).catch((error: any) => {
      logger.error(`[TorWebSocket] Send error: ${error}`);
    });
  }

  close(code?: number, _reason?: string): void {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    this.readyState = this.CLOSING;

    if (this.wsId) {
      TorProxy.closeWebSocket(this.wsId, code).catch(() => {});
    } else {
      // If we don't have wsId yet, wait for it then close
      this.pendingWsId.then((id) => {
        TorProxy.closeWebSocket(id, code).catch(() => {});
      }).catch(() => {});
    }
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    switch (type) {
      case 'open': this.onopen = listener; break;
      case 'message': this.onmessage = listener; break;
      case 'close': this.onclose = listener; break;
      case 'error': this.onerror = listener; break;
    }
  }

  removeEventListener(type: string, _listener: (event: any) => void): void {
    switch (type) {
      case 'open': this.onopen = null; break;
      case 'message': this.onmessage = null; break;
      case 'close': this.onclose = null; break;
      case 'error': this.onerror = null; break;
    }
  }

  // MARK: - Private

  private setupEventListeners(): void {
    const nativeModule: any = TorProxy.events;

    const onOpen = nativeModule.addListener('onWebSocketOpen', (event: TorWebSocketOpenEvent) => {
      if (!this.wsId) {
        this.pendingEvents.push({ type: 'open', event });
        return;
      }
      if (event.wsId !== this.wsId) return;
      this.handleOpen();
    });

    const onMessage = nativeModule.addListener('onWebSocketMessage', (event: TorWebSocketMessageEvent) => {
      if (!this.wsId) {
        this.pendingEvents.push({ type: 'message', event });
        return;
      }
      if (event.wsId !== this.wsId) return;
      this.handleMessage(event.data);
    });

    const onClose = nativeModule.addListener('onWebSocketClose', (event: TorWebSocketCloseEvent) => {
      if (!this.wsId) {
        this.pendingEvents.push({ type: 'close', event });
        return;
      }
      if (event.wsId !== this.wsId) return;
      this.handleClose(event.code, event.reason);
    });

    const onError = nativeModule.addListener('onWebSocketError', (event: TorWebSocketErrorEvent) => {
      if (!this.wsId) {
        this.pendingEvents.push({ type: 'error', event });
        return;
      }
      if (event.wsId !== this.wsId) return;
      this.handleError(event.error);
    });

    this.subscriptions = [
      () => onOpen.remove(),
      () => onMessage.remove(),
      () => onClose.remove(),
      () => onError.remove(),
    ];
  }

  private flushPendingEvents(): void {
    const events = this.pendingEvents;
    this.pendingEvents = [];

    for (const { type, event } of events) {
      if (event.wsId !== this.wsId) continue;

      switch (type) {
        case 'open': this.handleOpen(); break;
        case 'message': this.handleMessage(event.data); break;
        case 'close': this.handleClose(event.code, event.reason); break;
        case 'error': this.handleError(event.error); break;
      }
    }
  }

  private handleOpen(): void {
    this.readyState = this.OPEN;
    logger.info(`[TorWebSocket] Connected`);
    this.onopen?.({ type: 'open' });
  }

  private handleMessage(data: string): void {
    this.onmessage?.({ type: 'message', data });
  }

  private handleClose(code: number, reason: string): void {
    this.readyState = this.CLOSED;
    this.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 });
    this.cleanup();
  }

  private handleError(error: string): void {
    this.onerror?.({ type: 'error', message: error });
  }

  private cleanup(): void {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
    this.pendingEvents = [];
  }
}