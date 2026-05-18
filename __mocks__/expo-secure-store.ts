const store: Record<string, string> = {};

export async function getItemAsync(key: string): Promise<string | null> {
  return store[key] ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store[key] = value;
}

export async function deleteItemAsync(key: string): Promise<void> {
  delete store[key];
}

// Helper for tests to reset state
export function __reset(): void {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}

// Helper to inspect store
export function __getStore(): Record<string, string> {
  return { ...store };
}
