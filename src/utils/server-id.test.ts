import { toLocalRoomId, toBackendRoomId, getServerIdFromRoomId } from './server-id';

describe('server-id utilities', () => {
  describe('toLocalRoomId', () => {
    it('returns unchanged ID for server 0', () => {
      expect(toLocalRoomId(0, 42)).toBe(42);
    });

    it('offsets ID for server 1', () => {
      expect(toLocalRoomId(1, 42)).toBe(1_000_000_042);
    });

    it('offsets ID for server 2', () => {
      expect(toLocalRoomId(2, 1)).toBe(2_000_000_001);
    });

    it('handles backend room ID 0', () => {
      expect(toLocalRoomId(1, 0)).toBe(1_000_000_000);
    });
  });

  describe('toBackendRoomId', () => {
    it('extracts backend ID from server 0 room', () => {
      expect(toBackendRoomId(42)).toBe(42);
    });

    it('extracts backend ID from server 1 room', () => {
      expect(toBackendRoomId(1_000_000_042)).toBe(42);
    });

    it('extracts backend ID from server 2 room', () => {
      expect(toBackendRoomId(2_000_000_001)).toBe(1);
    });
  });

  describe('getServerIdFromRoomId', () => {
    it('returns 0 for server 0 rooms', () => {
      expect(getServerIdFromRoomId(42)).toBe(0);
    });

    it('returns 1 for server 1 rooms', () => {
      expect(getServerIdFromRoomId(1_000_000_042)).toBe(1);
    });

    it('returns 2 for server 2 rooms', () => {
      expect(getServerIdFromRoomId(2_000_000_001)).toBe(2);
    });
  });

  describe('round-trip', () => {
    it('round-trips server 0', () => {
      const local = toLocalRoomId(0, 123);
      expect(toBackendRoomId(local)).toBe(123);
      expect(getServerIdFromRoomId(local)).toBe(0);
    });

    it('round-trips server 1', () => {
      const local = toLocalRoomId(1, 456);
      expect(toBackendRoomId(local)).toBe(456);
      expect(getServerIdFromRoomId(local)).toBe(1);
    });

    it('round-trips large backend IDs', () => {
      const local = toLocalRoomId(3, 999_999_999);
      expect(toBackendRoomId(local)).toBe(999_999_999);
      expect(getServerIdFromRoomId(local)).toBe(3);
    });
  });
});
