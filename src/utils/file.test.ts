// Mock expo-file-system before importing file.ts so the module-level Directory
// usage in helpers doesn't fail. We only exercise the pure helpers here.
jest.mock('expo-file-system', () => ({
  File: class { exists = false; uri = ''; constructor() {} },
  Directory: class { exists = false; constructor() {} create() {} list() { return []; } delete() {} },
  Paths: { document: '/mock-documents/' },
}));

import { formatFileSize, getFileIcon, sanitizeFileName, MAX_FILE_SIZE } from './file';

describe('formatFileSize', () => {
  it('returns 0 B for zero or negative', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(-5)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('formats GB', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});

describe('getFileIcon', () => {
  it('maps PDF MIME', () => {
    expect(getFileIcon('application/pdf').color).toBe('#dc2626');
    expect(getFileIcon('application/pdf').icon).toBe('document-text');
  });

  it('falls back to filename extension when MIME is missing', () => {
    expect(getFileIcon(undefined, 'doc.pdf').color).toBe('#dc2626');
    expect(getFileIcon('', 'archive.zip').color).toBe('#a16207');
  });

  it('maps Word/Office documents', () => {
    expect(getFileIcon('application/vnd.openxmlformats-officedocument.wordprocessingml.document').icon).toBe('document-text');
    expect(getFileIcon('application/msword').icon).toBe('document-text');
    expect(getFileIcon(undefined, 'note.docx').icon).toBe('document-text');
  });

  it('maps Excel/spreadsheet documents', () => {
    expect(getFileIcon('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').icon).toBe('grid');
    expect(getFileIcon(undefined, 'data.xlsx').icon).toBe('grid');
    expect(getFileIcon(undefined, 'data.csv').icon).toBe('grid');
  });

  it('maps PowerPoint/presentation documents', () => {
    expect(getFileIcon('application/vnd.openxmlformats-officedocument.presentationml.presentation').icon).toBe('easel');
    expect(getFileIcon(undefined, 'deck.pptx').icon).toBe('easel');
  });

  it('maps archives', () => {
    expect(getFileIcon('application/zip').icon).toBe('archive');
    expect(getFileIcon('application/x-7z-compressed').icon).toBe('archive');
    expect(getFileIcon(undefined, 'photos.tar.gz').icon).toBe('archive');
  });

  it('maps images, video, audio by MIME prefix', () => {
    expect(getFileIcon('image/png').icon).toBe('image');
    expect(getFileIcon('video/mp4').icon).toBe('videocam');
    expect(getFileIcon('audio/mpeg').icon).toBe('musical-notes');
  });

  it('falls back to generic for unknown', () => {
    expect(getFileIcon('application/x-completely-made-up').icon).toBe('document');
    expect(getFileIcon(undefined).icon).toBe('document');
  });
});

describe('sanitizeFileName', () => {
  it('returns a default for empty input', () => {
    expect(sanitizeFileName('')).toBe('file');
  });

  it('strips path separators', () => {
    expect(sanitizeFileName('../etc/passwd')).toBe('.._etc_passwd');
    expect(sanitizeFileName('foo\\bar.txt')).toBe('foo_bar.txt');
  });

  it('strips control chars and forbidden characters', () => {
    expect(sanitizeFileName('a<b>c:"|d?*e')).toBe('a_b_c_d_e');
  });

  it('collapses internal whitespace', () => {
    expect(sanitizeFileName('  many    spaces.txt  ')).toBe('many spaces.txt');
  });

  it('caps length to 200 characters', () => {
    const long = 'a'.repeat(500) + '.txt';
    expect(sanitizeFileName(long).length).toBe(200);
  });
});

describe('MAX_FILE_SIZE', () => {
  it('matches the backend MEDIA_MAX_SIZE of 10 MB', () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
  });
});
