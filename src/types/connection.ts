/**
 * Socket connection state enum.
 *
 * Extracted to its own file to avoid circular dependency:
 *   socket.service → logger → app.store → socket.service
 */
export enum SocketConnectionState {
  CLOSED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
}