import { File, Directory, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { logger } from './logger';

const IMAGE_DIR_NAME = 'chat-images';
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 0.4;
const MICRO_THUMBNAIL_WIDTH = 80;
const MICRO_THUMBNAIL_QUALITY = 0.3;
const COLOR_PREVIEW_SIZE = 3; // 3x3 pixel grid for ephemeral image previews

// Message IDs come from the socket (envelope.id) and are concatenated into
// filenames. Reject anything that could escape the chat-images directory.
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
// Relative paths come from decrypted message bodies (parsed.filePath). They
// must stay inside the chat-images directory with a safe filename.
const SAFE_RELATIVE_PATH_RE = /^chat-images\/[A-Za-z0-9._-]{1,128}\.(jpg|png)$/;

function assertSafeMessageId(id: string): void {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new Error('Unsafe image id');
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    typeof relativePath !== 'string' ||
    !SAFE_RELATIVE_PATH_RE.test(relativePath) ||
    relativePath.includes('..')
  ) {
    throw new Error('Unsafe image path');
  }
}

/**
 * Get (and create if needed) the chat-images directory.
 */
function getImageDirectory(): Directory {
  const dir = new Directory(Paths.document, IMAGE_DIR_NAME);
  if (!dir.exists) {
    dir.create();
  }
  return dir;
}

/**
 * Generate a small thumbnail from a local image URI.
 * Returns the thumbnail as a base64 string (no prefix).
 */
export async function generateThumbnail(imageUri: string): Promise<string> {
  try {
    const ctx = ImageManipulator.manipulate(imageUri);
    const rendered = await ctx.resize({ width: THUMBNAIL_WIDTH }).renderAsync();
    const result = await rendered.saveAsync({ compress: THUMBNAIL_QUALITY, format: SaveFormat.JPEG, base64: true });

    return result.base64 ?? '';
  } catch (error) {
    logger.warn('[Image] Thumbnail generation failed:', error);
    return '';
  }
}

/**
 * Generate a thumbnail from a base64 image string.
 * Writes to a temp file first since manipulateAsync requires a file URI.
 */
export async function generateThumbnailFromBase64(
  base64: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const dir = getImageDirectory();
  const tempFile = new File(dir, `thumb_temp_${Date.now()}.jpg`);

  try {
    // Write base64 to temp file
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    tempFile.write(bytes);

    const thumbnail = await generateThumbnail(tempFile.uri);

    // Clean up temp file
    if (tempFile.exists) {
      tempFile.delete();
    }

    return thumbnail;
  } catch (error) {
    logger.warn('[Image] Thumbnail from base64 failed:', error);
    try { if (tempFile.exists) tempFile.delete(); } catch {}
    return '';
  }
}

/**
 * Generate a micro-thumbnail from a base64 image string.
 * Much smaller than the standard thumbnail (~80px, 0.3 quality, <3KB base64)
 * to keep WebSocket payloads under the 64KB server limit.
 */
export async function generateMicroThumbnailFromBase64(
  base64: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const dir = getImageDirectory();
  const tempFile = new File(dir, `micro_temp_${Date.now()}.jpg`);

  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    tempFile.write(bytes);

    const ctx = ImageManipulator.manipulate(tempFile.uri);
    const rendered = await ctx.resize({ width: MICRO_THUMBNAIL_WIDTH }).renderAsync();
    const result = await rendered.saveAsync({ compress: MICRO_THUMBNAIL_QUALITY, format: SaveFormat.JPEG, base64: true });

    if (tempFile.exists) {
      tempFile.delete();
    }

    return result.base64 ?? '';
  } catch (error) {
    logger.warn('[Image] Micro-thumbnail from base64 failed:', error);
    try { if (tempFile.exists) tempFile.delete(); } catch {}
    return '';
  }
}

/**
 * Generate a color preview (3x3 pixel grid) from a base64 image.
 * Used for ephemeral images — reveals only dominant colors as abstract blobs,
 * no recognizable content. Output is ~100-200 bytes base64.
 */
export async function generateColorPreviewFromBase64(
  base64: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const dir = getImageDirectory();
  const tempFile = new File(dir, `color_preview_temp_${Date.now()}.jpg`);

  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    tempFile.write(bytes);

    const ctx = ImageManipulator.manipulate(tempFile.uri);
    const rendered = await ctx.resize({ width: COLOR_PREVIEW_SIZE }).renderAsync();
    const result = await rendered.saveAsync({ compress: 1.0, format: SaveFormat.JPEG, base64: true });

    if (tempFile.exists) {
      tempFile.delete();
    }

    return result.base64 ?? '';
  } catch (error) {
    logger.warn('[Image] Color preview from base64 failed:', error);
    try { if (tempFile.exists) tempFile.delete(); } catch {}
    return '';
  }
}

/**
 * Save a base64 image to the filesystem.
 * Returns the relative path (from document directory) for storage.
 */
export async function saveImageToFile(
  base64: string,
  messageId: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  assertSafeMessageId(messageId);
  const dir = getImageDirectory();
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const fileName = `${messageId}.${ext}`;
  const file = new File(dir, fileName);

  // Decode base64 to bytes and write
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  file.write(bytes);

  // Return relative path for storage (document directory path can change)
  return `${IMAGE_DIR_NAME}/${fileName}`;
}

/**
 * Resolve a relative image path to an absolute file URI for display.
 */
export function resolveImagePath(relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const file = new File(Paths.document, relativePath);
  return file.uri;
}

/**
 * Check if an image file exists on the filesystem.
 */
export function imageFileExists(relativePath: string): boolean {
  try {
    assertSafeRelativePath(relativePath);
  } catch {
    return false;
  }
  const file = new File(Paths.document, relativePath);
  return file.exists;
}

/**
 * Delete image files for a list of message IDs.
 * Tries both .jpg and .png extensions.
 */
export function deleteImagesByMessageIds(messageIds: string[]): void {
  const dir = getImageDirectory();
  for (const id of messageIds) {
    if (!SAFE_ID_RE.test(id)) continue;
    for (const ext of ['jpg', 'png']) {
      const file = new File(dir, `${id}.${ext}`);
      if (file.exists) {
        file.delete();
      }
    }
  }
}

/**
 * Read an image file from the filesystem as base64.
 * Accepts a relative path (from document directory).
 */
export async function readImageAsBase64(relativePath: string): Promise<string> {
  assertSafeRelativePath(relativePath);
  const file = new File(Paths.document, relativePath);
  if (!file.exists) {
    throw new Error(`Image file not found: ${relativePath}`);
  }
  const bytes = await file.bytes();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Delete the entire chat-images directory (e.g. on logout / identity clear).
 */
export function deleteAllImages(): void {
  const dir = new Directory(Paths.document, IMAGE_DIR_NAME);
  if (dir.exists) {
    dir.delete();
  }
}

/**
 * Ensure we have a file:// URI for the image described by imageData JSON.
 * If the image has a filePath on disk, resolves it.
 * If only base64 is available, writes a temp file and returns its URI.
 * Returns null if no image data is usable.
 */
export function ensureImageFileUri(imageData: string): string | null {
  try {
    const parsed = JSON.parse(imageData);

    if (parsed.filePath) {
      return resolveImagePath(parsed.filePath);
    }

    if (parsed.base64) {
      const dir = getImageDirectory();
      const ext = (parsed.mimeType as string)?.includes('png') ? 'png' : 'jpg';
      const tempFile = new File(dir, `share_${Date.now()}.${ext}`);
      const binaryString = atob(parsed.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      tempFile.write(bytes);
      return tempFile.uri;
    }
  } catch {
    // Invalid JSON or missing data
  }
  return null;
}

/**
 * Convert a file path (e.g. from share intent) to an ImageMessagePayload-compatible object.
 * Resizes to 1280px width, compresses at 0.7 quality (same as useImagePicker).
 */
export async function convertFileToImagePayload(
  filePath: string,
  mimeType: string = 'image/jpeg'
): Promise<{ base64: string; mimeType: string; width: number; height: number; size: number }> {
  const format = mimeType.includes('png') ? SaveFormat.PNG : SaveFormat.JPEG;
  const outputMimeType = mimeType.includes('png') ? 'image/png' : 'image/jpeg';

  const ctx = ImageManipulator.manipulate(filePath);
  const rendered = await ctx.resize({ width: 1280 }).renderAsync();
  const result = await rendered.saveAsync({ compress: 0.7, format, base64: true });

  const base64 = result.base64 ?? '';
  return {
    base64,
    mimeType: outputMimeType,
    width: result.width,
    height: result.height,
    size: Math.round(base64.length * 0.75),
  };
}