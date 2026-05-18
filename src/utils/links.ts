import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import LinkifyIt from 'linkify-it';
import { logger } from './logger';

const linkify = new LinkifyIt({}, {
  fuzzyLink: true,
  fuzzyEmail: true,
  fuzzyIP: false,
});

export type TextSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; url: string; raw: string };

export function splitTextWithLinks(body: string): TextSegment[] {
  if (!body) return [];

  const matches = linkify.match(body);
  if (!matches || matches.length === 0) {
    return [{ type: 'text', value: body }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const m of matches) {
    if (m.index > cursor) {
      segments.push({ type: 'text', value: body.slice(cursor, m.index) });
    }
    segments.push({ type: 'link', url: m.url, raw: m.raw });
    cursor = m.lastIndex;
  }

  if (cursor < body.length) {
    segments.push({ type: 'text', value: body.slice(cursor) });
  }

  return segments;
}

export function extractFirstLink(body: string): string | null {
  if (!body) return null;
  const matches = linkify.match(body);
  return matches && matches.length > 0 ? matches[0].url : null;
}

export function hasLink(body: string): boolean {
  if (!body) return false;
  return linkify.test(body);
}

/**
 * Lowercase the URL scheme. Android Intent dispatching is case-sensitive on
 * the scheme, so "Https://example.com" fails with "No matching browser
 * activity found" even though the URL is otherwise valid.
 */
function normalizeUrl(url: string): string {
  const m = url.match(/^([A-Za-z][A-Za-z0-9+\-.]*):/);
  if (!m) return url;
  return m[1].toLowerCase() + url.slice(m[1].length);
}

// Schemes we will hand to the OS. Anything else (intent://, file://, content://,
// javascript:, app-specific deep links, …) is dropped because the URL may come
// from a decrypted message body and an attacker-controlled scheme would let a
// crafted message dispatch arbitrary intents on Android.
const ALLOWED_SCHEME_RE = /^(https?|mailto|tel):/i;

export async function openLink(url: string): Promise<void> {
  const normalized = normalizeUrl(url);

  if (!ALLOWED_SCHEME_RE.test(normalized)) {
    logger.warn('[openLink] refusing non-whitelisted scheme', normalized.slice(0, 32));
    return;
  }

  if (Platform.OS === 'web' || normalized.startsWith('mailto:') || normalized.startsWith('tel:')) {
    try {
      await Linking.openURL(normalized);
    } catch (e) {
      logger.warn('[openLink] failed to open', normalized, e);
    }
    return;
  }

  // Try the in-app browser first (Safari View Controller / Chrome Custom Tabs).
  try {
    await WebBrowser.openBrowserAsync(normalized, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    });
    return;
  } catch (innerErr) {
    logger.warn('[openLink] in-app browser unavailable, falling back to system browser', innerErr);
  }

  // Fallback to the system browser. Useful on AOSP emulators / devices
  // without Chrome installed.
  try {
    await Linking.openURL(normalized);
  } catch (e) {
    logger.warn('[openLink] failed to open', normalized, e);
  }
}
