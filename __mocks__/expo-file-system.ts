const files: Record<string, string> = {};

export const documentDirectory = '/mock-documents/';
export const cacheDirectory = '/mock-cache/';

export async function readAsStringAsync(fileUri: string): Promise<string> {
  const content = files[fileUri];
  if (content === undefined) {
    throw new Error(`File not found: ${fileUri}`);
  }
  return content;
}

export async function writeAsStringAsync(fileUri: string, contents: string): Promise<void> {
  files[fileUri] = contents;
}

export async function deleteAsync(fileUri: string): Promise<void> {
  delete files[fileUri];
}

export async function getInfoAsync(fileUri: string): Promise<{ exists: boolean; size: number }> {
  const exists = fileUri in files;
  return { exists, size: exists ? files[fileUri].length : 0 };
}

export async function makeDirectoryAsync(_fileUri: string): Promise<void> {}

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
};

// Helper for tests
export function __reset(): void {
  for (const key of Object.keys(files)) {
    delete files[key];
  }
}
