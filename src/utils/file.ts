import { File, Directory, Paths } from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { logger } from './logger';

export const FILE_DIR_NAME = 'chat-files';
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface FileIconInfo {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}

const ICON_PDF: FileIconInfo = { icon: 'document-text', color: '#dc2626' };
const ICON_WORD: FileIconInfo = { icon: 'document-text', color: '#2563eb' };
const ICON_EXCEL: FileIconInfo = { icon: 'grid', color: '#16a34a' };
const ICON_PPT: FileIconInfo = { icon: 'easel', color: '#ea580c' };
const ICON_ARCHIVE: FileIconInfo = { icon: 'archive', color: '#a16207' };
const ICON_IMAGE: FileIconInfo = { icon: 'image', color: '#7c3aed' };
const ICON_VIDEO: FileIconInfo = { icon: 'videocam', color: '#0ea5e9' };
const ICON_AUDIO: FileIconInfo = { icon: 'musical-notes', color: '#9333ea' };
const ICON_TEXT: FileIconInfo = { icon: 'document-text-outline', color: '#6b7280' };
const ICON_CODE: FileIconInfo = { icon: 'code-slash', color: '#0891b2' };
const ICON_GENERIC: FileIconInfo = { icon: 'document', color: '#6b7280' };

export function getFileIcon(mimeType: string | undefined, fileName?: string): FileIconInfo {
  const m = (mimeType || '').toLowerCase();
  const ext = (fileName?.split('.').pop() || '').toLowerCase();

  if (m === 'application/pdf' || ext === 'pdf') return ICON_PDF;
  if (m.includes('wordprocessingml') || m === 'application/msword' || ['doc', 'docx', 'rtf', 'odt'].includes(ext)) return ICON_WORD;
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel' || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return ICON_EXCEL;
  if (m.includes('presentationml') || m === 'application/vnd.ms-powerpoint' || ['ppt', 'pptx', 'key', 'odp'].includes(ext)) return ICON_PPT;
  if (m === 'application/zip' || m === 'application/x-zip-compressed' || m === 'application/x-rar-compressed' || m === 'application/x-7z-compressed' || m === 'application/x-tar' || m === 'application/gzip' || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return ICON_ARCHIVE;
  if (m.startsWith('image/')) return ICON_IMAGE;
  if (m.startsWith('video/')) return ICON_VIDEO;
  if (m.startsWith('audio/')) return ICON_AUDIO;
  if (m === 'text/plain' || m === 'text/markdown' || ['txt', 'md', 'log'].includes(ext)) return ICON_TEXT;
  if (m === 'application/json' || m === 'application/xml' || m.startsWith('text/x-') || ['json', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'rb', 'go', 'rs'].includes(ext)) return ICON_CODE;

  return ICON_GENERIC;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Sanitize a file name so it's safe to use as a filesystem entry.
 * Strips path separators and control chars, collapses whitespace.
 */
export function sanitizeFileName(name: string): string {
  return (name || 'file')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'file';
}

function getFileDirectory(): Directory {
  const dir = new Directory(Paths.document, FILE_DIR_NAME);
  if (!dir.exists) {
    dir.create();
  }
  return dir;
}

/**
 * Save base64 file data to the chat-files directory.
 * Returns the relative path (from document directory) for storage.
 */
export function saveFileToCache(base64: string, messageId: string, fileName: string): string {
  const dir = getFileDirectory();
  const safe = sanitizeFileName(fileName);
  const storedName = `${messageId}_${safe}`;
  const file = new File(dir, storedName);

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  file.write(bytes);

  return `${FILE_DIR_NAME}/${storedName}`;
}

export function resolveFilePath(relativePath: string): string {
  const file = new File(Paths.document, relativePath);
  return file.uri;
}

export function fileExists(relativePath: string): boolean {
  const file = new File(Paths.document, relativePath);
  return file.exists;
}

/**
 * Read a file from the document directory as base64.
 * Accepts a relative path (`chat-files/...`) or an absolute file:// URI.
 */
export async function readFileAsBase64(pathOrUri: string): Promise<string> {
  const file = pathOrUri.startsWith('file://')
    ? new File(pathOrUri)
    : new File(Paths.document, pathOrUri);
  if (!file.exists) {
    throw new Error(`File not found: ${pathOrUri}`);
  }
  const bytes = await file.bytes();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Delete cached file blobs for a list of message IDs.
 * Cached files are stored as `${messageId}_${safeName}`.
 */
export function deleteFilesByMessageIds(messageIds: string[]): void {
  const dir = new Directory(Paths.document, FILE_DIR_NAME);
  if (!dir.exists) return;
  try {
    const ids = new Set(messageIds);
    const entries = dir.list();
    for (const entry of entries) {
      if (entry instanceof File) {
        const fname = entry.name || '';
        const underscore = fname.indexOf('_');
        const messageId = underscore > 0 ? fname.slice(0, underscore) : fname;
        if (ids.has(messageId)) {
          try { entry.delete(); } catch (err) { logger.warn('[File] delete failed:', err); }
        }
      }
    }
  } catch (err) {
    logger.warn('[File] deleteFilesByMessageIds error:', err);
  }
}

/**
 * Delete the entire chat-files directory (e.g. on logout / identity clear).
 */
export function deleteAllFiles(): void {
  const dir = new Directory(Paths.document, FILE_DIR_NAME);
  if (dir.exists) {
    dir.delete();
  }
}
