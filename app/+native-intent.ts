import { getShareExtensionKey } from 'expo-share-intent';
import { useAppStore } from '@/stores/app.store';

export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) {
      if (!initial) {
        // Warm start: app is already running and authenticated.
        // Navigate directly to /share-target. _layout.tsx will detect
        // inShareTarget and skip its own redirect.
        return '/share-target';
      }
      // Cold start: _layout.tsx will handle auth first, then redirect
      // to /share-target via hasShareIntent after auth completes.
      return '/';
    }

    // Universal link: https://tillit.cc/roomcode/ABC123
    // Expo Router receives path as: /roomcode/ABC123
    // Length is bounded to avoid wasting time on adversarial long inputs.
    const roomCodeMatch = path.match(/\/roomcode\/([A-Za-z0-9_-]{4,64})(?:[/?#]|$)/);
    if (roomCodeMatch) {
      useAppStore.getState().setPendingInviteCode(roomCodeMatch[1]);
      return '/join-room';
    }

    return path;
  } catch {
    return '/';
  }
}