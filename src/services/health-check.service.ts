import { serverRegistry } from './server-registry';
import { useServerStore } from '@/stores/server.store';
import { logger } from '@/utils/logger';

class HealthCheckService {
  private checking = false;

  async checkServer(serverId: number): Promise<void> {
    try {
      const api = serverRegistry.getApi(serverId);
      const status = await api.checkAuthStatus();

      const wasBanned = useServerStore.getState().isBanned(serverId);
      const isBanned = status === 'banned';

      useServerStore.getState().setBanned(serverId, isBanned);

      if (isBanned && !wasBanned) {
        const server = serverRegistry.getServer(serverId);
        logger.warn(`[HealthCheck] Server ${serverId} (${server?.name}): account banned — disconnecting`);
        const socket = serverRegistry.getSocket(serverId);
        socket.disconnect();
      } else if (!isBanned && wasBanned) {
        const server = serverRegistry.getServer(serverId);
        logger.info(`[HealthCheck] Server ${serverId} (${server?.name}): ban lifted`);
      }
    } catch (error) {
      logger.warn(`[HealthCheck] Error checking server ${serverId}:`, error);
    }
  }

  async checkAll(): Promise<void> {
    if (this.checking) return;
    this.checking = true;

    try {
      const servers = serverRegistry.getAllServers();
      for (const server of servers) {
        await this.checkServer(server.id);
      }
    } finally {
      this.checking = false;
    }
  }
}

export const healthCheckService = new HealthCheckService();
