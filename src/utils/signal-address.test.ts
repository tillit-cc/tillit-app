import { signalAddressName, signalAddressNameForRoom } from './signal-address';
import { toLocalRoomId } from './server-id';

describe('signal-address namespacing (frontend-0027)', () => {
  describe('signalAddressName', () => {
    it('keeps the bare userId for the default server (serverId 0)', () => {
      expect(signalAddressName(0, 2)).toBe('2');
      expect(signalAddressName(0, '42')).toBe('42');
    });

    it('prefixes non-default servers with the serverId', () => {
      expect(signalAddressName(1, 2)).toBe('1:2');
      expect(signalAddressName(7, '2')).toBe('7:2');
    });

    it('disambiguates the same bare userId across servers', () => {
      // The exact collision frontend-0027 fixes: userId 2 on two servers.
      expect(signalAddressName(0, 2)).not.toBe(signalAddressName(3, 2));
    });
  });

  describe('signalAddressNameForRoom', () => {
    it('derives the namespace from the roomId server offset', () => {
      // Default server room → bare.
      expect(signalAddressNameForRoom(toLocalRoomId(0, 55), 2)).toBe('2');
      // Server 4 room → prefixed.
      expect(signalAddressNameForRoom(toLocalRoomId(4, 55), 2)).toBe('4:2');
    });

    it('is stable for the same (server, user) regardless of roomId within the server', () => {
      const a = signalAddressNameForRoom(toLocalRoomId(2, 10), 9);
      const b = signalAddressNameForRoom(toLocalRoomId(2, 999), 9);
      expect(a).toBe(b);
      expect(a).toBe('2:9');
    });
  });
});
