import { TorProxy, TorStatus } from 'tor-proxy';
import { logger } from '@/utils/logger';

/**
 * Singleton managing the Tor daemon lifecycle.
 * Starts Tor only when at least one .onion server is configured.
 * Stops on background, restarts on foreground.
 */
class TorService {
  private _status: TorStatus = 'stopped';
  private socksPort: number | null = null;
  private startPromise: Promise<number> | null = null;

  /**
   * Ensure Tor is started. Returns the SOCKS port.
   * Idempotent: if already started, returns the existing port.
   * If a start is in progress, waits for it.
   */
  async ensureStarted(): Promise<number> {
    if (this._status === 'connected' && this.socksPort) {
      return this.socksPort;
    }

    // Avoid concurrent start attempts
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    try {
      const port = await this.startPromise;
      return port;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<number> {
    logger.info('[TorService] Starting Tor daemon...');
    this._status = 'connecting';

    try {
      const result = await TorProxy.start();
      this.socksPort = result.socksPort;
      this._status = 'connected';
      logger.info(`[TorService] Tor connected, SOCKS port: ${result.socksPort}`);
      return result.socksPort;
    } catch (error: any) {
      this._status = 'stopped';
      this.socksPort = null;
      logger.error(`[TorService] Failed to start Tor: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Stop the Tor daemon.
   *
   * NOTE: Arti (arti-mobile-ex) does not support clean stop/restart in the same
   * process — stop_arti() sets state to "Stopping" asynchronously, and start_arti()
   * rejects calls until the state reaches "Stopped", with no API to wait for it.
   * To avoid the restart issue, we keep Arti running for the app lifetime.
   * The cost is minimal (few MB RAM, no CPU when idle).
   */
  async stop(): Promise<void> {
    // Intentionally kept as no-op. Arti stays running once started.
    // The SOCKS proxy on localhost:19150 remains available.
    logger.info('[TorService] Stop requested — keeping Arti running (restart not supported)');
  }

  /**
   * Get the current Tor status.
   */
  getStatus(): TorStatus {
    return this._status;
  }
}

export const torService = new TorService();
