import { File, Directory, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { setDiagSink } from '@/utils/logger';
import { redactCtx, reRedactText, type DiagCtx } from '@/utils/diag-redact';

// On-device diagnostic logging (frontend-0028).
//
// Opt-in, zero-backend. When enabled, structured entries + every line emitted
// through the existing `logger` are appended to a bounded, persistent ring
// buffer on disk. The user can export the buffer via the share sheet (with a
// final re-redaction pass) or wipe it. When disabled, NOTHING is written.

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEntry {
  ts: number;
  level: DiagLevel;
  category: string;
  event: string;
  ctx?: DiagCtx;
}

const DIR_NAME = 'diagnostics';
const BUFFER_FILE = 'buffer.jsonl';
const CONFIG_FILE = 'config.json';
const EXPORT_PREFIX = 'tillit-diagnostics-';

const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const FLUSH_DEBOUNCE_MS = 1500;

class DiagnosticsService {
  private enabled = false;
  private initialized = false;
  private buffer: DiagEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  // ----- lifecycle -----

  /**
   * Idempotent. Loads the opt-in flag and any persisted buffer from disk, then
   * wires the logger transport so existing log lines feed the buffer. Safe to
   * call before biometric unlock — it touches only the document directory, not
   * the encrypted DB.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      this.loadConfig();
      if (this.enabled) this.loadBuffer();
    } catch (err) {
      // Never let diagnostics break app startup.
      console.warn('[Diagnostics] init failed:', err);
    }
    // Forward already-sanitized logger lines into the buffer (the "transport").
    setDiagSink((level, message) => {
      if (!this.enabled) return;
      this.record(level === 'log' ? 'info' : level, 'log', message);
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(value: boolean): Promise<void> {
    if (!this.initialized) await this.init();
    if (this.enabled === value) return;
    this.enabled = value;
    this.saveConfig();
    if (value) {
      this.loadBuffer();
      this.record('info', 'diag', 'logging.enabled', this.deviceCtx());
    } else {
      // Stop capturing; persist whatever we have so a later export still works.
      this.flushNow();
    }
  }

  // ----- recording -----

  record(level: DiagLevel, category: string, event: string, ctx?: DiagCtx): void {
    if (!this.enabled) return;
    const entry: DiagEntry = {
      ts: Date.now(),
      level,
      category,
      event,
      ctx: redactCtx(ctx),
    };
    this.buffer.push(entry);
    this.trim();
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Convenience helpers used at instrumentation sites. */
  event(category: string, event: string, ctx?: DiagCtx): void {
    this.record('info', category, event, ctx);
  }
  warn(category: string, event: string, ctx?: DiagCtx): void {
    this.record('warn', category, event, ctx);
  }
  error(category: string, event: string, ctx?: DiagCtx): void {
    this.record('error', category, event, ctx);
  }

  private trim(): void {
    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer = this.buffer.slice(-MAX_ENTRIES);
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    if (this.buffer.length && this.buffer[0].ts < cutoff) {
      this.buffer = this.buffer.filter((e) => e.ts >= cutoff);
    }
  }

  // ----- export / wipe -----

  /**
   * Serialize the buffer to a shareable file with a device/app header and a
   * final re-redaction pass. Returns the file URI (caller hands it to the
   * share sheet). Returns null when the buffer is empty.
   */
  async export(): Promise<{ uri: string; name: string } | null> {
    if (!this.initialized) await this.init();
    this.flushNow();
    if (this.buffer.length === 0) return null;

    const header = this.buildHeader();
    const body = this.buffer.map((e) => JSON.stringify(e)).join('\n');
    // Defense-in-depth: re-redact the WHOLE blob before it leaves the device.
    const content = reRedactText(`${header}\n${body}\n`);

    const dir = this.getDir();
    this.cleanupExports(dir);
    const name = `${EXPORT_PREFIX}${this.stamp()}.txt`;
    const file = new File(dir, name);
    if (file.exists) file.delete();
    file.write(content);
    return { uri: file.uri, name };
  }

  async wipe(): Promise<void> {
    if (!this.initialized) await this.init();
    this.buffer = [];
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const dir = this.getDir();
      const bufFile = new File(dir, BUFFER_FILE);
      if (bufFile.exists) bufFile.delete();
      this.cleanupExports(dir);
    } catch (err) {
      console.warn('[Diagnostics] wipe failed:', err);
    }
  }

  /** Best-effort flush, e.g. on app background. */
  onBackground(): void {
    if (this.enabled && this.dirty) this.flushNow();
  }

  // ----- persistence internals -----

  private getDir(): Directory {
    const dir = new Directory(Paths.document, DIR_NAME);
    if (!dir.exists) dir.create();
    return dir;
  }

  private loadConfig(): void {
    const file = new File(this.getDir(), CONFIG_FILE);
    if (!file.exists) return;
    try {
      const parsed = JSON.parse(file.textSync());
      this.enabled = parsed?.enabled === true;
    } catch {
      this.enabled = false;
    }
  }

  private saveConfig(): void {
    try {
      const file = new File(this.getDir(), CONFIG_FILE);
      if (file.exists) file.delete();
      file.write(JSON.stringify({ enabled: this.enabled }));
    } catch (err) {
      console.warn('[Diagnostics] saveConfig failed:', err);
    }
  }

  private loadBuffer(): void {
    try {
      const file = new File(this.getDir(), BUFFER_FILE);
      if (!file.exists) {
        this.buffer = [];
        return;
      }
      const text = file.textSync();
      const cutoff = Date.now() - MAX_AGE_MS;
      const entries: DiagEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as DiagEntry;
          if (typeof e?.ts === 'number' && e.ts >= cutoff) entries.push(e);
        } catch {
          // skip corrupt line
        }
      }
      this.buffer = entries.slice(-MAX_ENTRIES);
    } catch (err) {
      console.warn('[Diagnostics] loadBuffer failed:', err);
      this.buffer = [];
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushNow(): void {
    if (!this.dirty) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const file = new File(this.getDir(), BUFFER_FILE);
      if (file.exists) file.delete();
      file.write(this.buffer.map((e) => JSON.stringify(e)).join('\n'));
      this.dirty = false;
    } catch (err) {
      console.warn('[Diagnostics] flush failed:', err);
    }
  }

  // ----- helpers -----

  /** Remove previously generated export files so they don't accumulate. */
  private cleanupExports(dir: Directory): void {
    try {
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.startsWith(EXPORT_PREFIX)) {
          entry.delete();
        }
      }
    } catch {
      // ignore
    }
  }

  private deviceCtx(): DiagCtx {
    // Lazy-require the native info modules so importing this service (e.g. in
    // unit tests) doesn't pull the jest-expo native preset at module load.
    const Application = require('expo-application');
    const Device = require('expo-device');
    return {
      platform: Platform.OS,
      osVersion: Device.osVersion ?? null,
      model: Device.modelName ?? null,
      appVersion: Application.nativeApplicationVersion ?? null,
      build: Application.nativeBuildVersion ?? null,
    };
  }

  private buildHeader(): string {
    const d = this.deviceCtx();
    return [
      '# TilliT diagnostics export',
      '# Redacted on-device — contains identifiers/metadata only, no keys or message content.',
      `# app=${d.appVersion} build=${d.build} platform=${d.platform} os=${d.osVersion} model=${d.model}`,
      `# generatedAt=${new Date().toISOString()} entries=${this.buffer.length}`,
      '#',
    ].join('\n');
  }

  private stamp(): string {
    // Filesystem-safe ISO timestamp.
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
}

export const diagnostics = new DiagnosticsService();
