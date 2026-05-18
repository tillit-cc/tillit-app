import i18next from 'i18next';
import { UserMessageType, UserMessageTypeValue } from '@/types/message';

const DEFAULT_TRUNCATE = 50;

interface PreviewOptions {
  truncate?: number;
  fallback?: string;
}

/**
 * User-facing preview string for any message type.
 * Single source of truth for: chat list (last message), reply bar, reply
 * preview inside bubbles, and any other place that needs a one-liner.
 *
 * When a new `UserMessageType` is added, add an explicit `case` here —
 * `exhaustive` makes the new type a TypeScript error until handled.
 */
export function getMessagePreview(
  body: string | null | undefined,
  type?: string | null,
  options: PreviewOptions = {}
): string {
  const truncate = options.truncate ?? DEFAULT_TRUNCATE;
  const fallback = options.fallback ?? i18next.t('chat.message');

  switch (type as UserMessageTypeValue) {
    case UserMessageType.TEXT:
      return truncateText(body, truncate, fallback);

    case UserMessageType.IMAGE:
    case UserMessageType.PERSISTENT_IMAGE:
      return i18next.t('chat.image');

    case UserMessageType.EPHEMERAL_IMAGE:
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.expired === true) return i18next.t('chat.imageExpired');
        } catch {}
      }
      return i18next.t('chat.ephemeralImage');

    case UserMessageType.AUDIO:
      return i18next.t('chat.audio');

    case UserMessageType.VIDEO:
      return i18next.t('chat.video');

    case UserMessageType.FILE:
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.fileName) return `📎 ${parsed.fileName}`;
        } catch {}
      }
      return i18next.t('chat.document');

    case UserMessageType.LOCATION:
      return i18next.t('chat.location');
  }

  // Type unknown / missing (legacy rows or migration in-flight) — fall back
  // to body-based heuristics. Once `lastMessageType` is populated everywhere,
  // this branch becomes effectively dead for fresh messages.
  return inferFromBody(body, truncate, fallback);
}

function truncateText(
  body: string | null | undefined,
  truncate: number,
  fallback: string
): string {
  if (!body) return fallback;
  return body.length > truncate ? body.substring(0, truncate) + '...' : body;
}

function inferFromBody(
  body: string | null | undefined,
  truncate: number,
  fallback: string
): string {
  if (!body) return fallback;

  if (body.startsWith('data:image/')) return i18next.t('chat.image');

  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed?.expired === true) return i18next.t('chat.imageExpired');
      if (parsed?.viewDuration != null) return i18next.t('chat.ephemeralImage');
      if (parsed?.fileName) return `📎 ${parsed.fileName}`;
      if (parsed?.filePath || parsed?.base64 || parsed?.mediaId) {
        return i18next.t('chat.image');
      }
      return fallback;
    } catch {}
  }

  return truncateText(body, truncate, fallback);
}
