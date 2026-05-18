const SERVER_ID_MULTIPLIER = 1_000_000_000;

/**
 * Convert a backend room ID to a local room ID that encodes the server.
 * Server 0: IDs unchanged. Server 1: IDs 1_000_000_001+.
 */
export function toLocalRoomId(serverId: number, backendRoomId: number): number {
  return serverId * SERVER_ID_MULTIPLIER + backendRoomId;
}

/**
 * Extract the backend room ID from a local room ID.
 */
export function toBackendRoomId(localRoomId: number): number {
  return localRoomId % SERVER_ID_MULTIPLIER;
}

/**
 * Extract the server ID from a local room ID.
 */
export function getServerIdFromRoomId(localRoomId: number): number {
  return Math.floor(localRoomId / SERVER_ID_MULTIPLIER);
}
