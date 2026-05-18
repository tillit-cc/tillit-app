import Zeroconf from 'react-native-zeroconf';
import { logger } from '@/utils/logger';

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  apiUrl: string;
  lanUrl?: string;
  onionUrl?: string;
  isSecure: boolean;
  txtRecord: Record<string, string>;
}

type ChangeListener = (servers: DiscoveredServer[]) => void;

// Loopback / wildcard / link-local — both IPv4 and IPv6. An mDNS responder on
// the LAN could otherwise advertise these and trick the app into hitting an
// attacker-controlled local listener.
function isLoopbackOrLinkLocal(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (/^127\./.test(h)) return true;
  if (h === '0.0.0.0') return true;
  if (/^169\.254\./.test(h)) return true;          // IPv4 link-local
  if (h === '::' || h === '[::]') return true;
  if (h === '::1' || h === '[::1]') return true;   // IPv6 loopback
  if (/^\[?fe80:/.test(h)) return true;            // IPv6 link-local
  return false;
}

// Hostname syntax check for TXT-advertised public hosts. Rejects schemes,
// paths, whitespace, control chars; bounds total length.
function isValidHostname(h: string): boolean {
  if (!h || h.length > 253) return false;
  if (/[\s/?#@]/.test(h)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(h)) return false;
  return /^[a-zA-Z0-9._:\-\[\]]+$/.test(h);
}

// Onion v3 addresses are 56 chars of base32 (a-z, 2-7) plus the `.onion` TLD.
function isValidOnionAddress(addr: string): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  const withoutTld = a.endsWith('.onion') ? a.slice(0, -6) : a;
  return /^[a-z2-7]{56}$/.test(withoutTld);
}

class DiscoveryService {
  private zc: Zeroconf | null = null;
  private discovered = new Map<string, DiscoveredServer>();
  private listeners = new Set<ChangeListener>();
  private scanning = false;

  startScan(): void {
    if (this.scanning) return;

    this.discovered.clear();
    this.notifyListeners();

    this.zc = new Zeroconf();
    this.scanning = true;

    this.zc.on('resolved', (service: any) => {
      logger.info(`[Discovery] Resolved: ${service.name} @ ${service.host}:${service.port}`);

      const txt: Record<string, string> = service.txt ?? {};
      const protocol = txt.protocol || 'http';
      const path = txt.path || '';
      const localHost = service.host || (service.addresses?.[0] ?? 'unknown');
      const port = service.port ?? 80;
      const txtHost = txt.host;   // Public URL hostname from TXT (tunnel/HTTPS)
      const onion = txt.onion;    // Tor .onion address from TXT

      // Validate protocol
      if (protocol !== 'https' && protocol !== 'http') {
        logger.warn(`[Discovery] Rejected ${service.name}: invalid protocol "${protocol}"`);
        return;
      }

      // Sanitize path: reject traversal, query strings, fragments
      if (path && (/\.\./.test(path) || /[?#]/.test(path))) {
        logger.warn(`[Discovery] Rejected ${service.name}: invalid path "${path}"`);
        return;
      }

      // Reject loopback / wildcard / link-local. Covers IPv4 (127.*, 0.0.0.0,
      // 169.254.*) and IPv6 (::1, ::, fe80:*). An attacker on the LAN could
      // otherwise publish an mDNS record pointing at the device's own
      // loopback and capture credentials sent during server enrolment.
      if (isLoopbackOrLinkLocal(localHost)) {
        logger.warn(`[Discovery] Rejected ${service.name}: loopback/link-local not allowed`);
        return;
      }

      // LAN URL — always built from mDNS-discovered host:port
      const lanRaw = `${protocol}://${localHost}:${port}${path}`;

      // Build primary apiUrl with priority:
      // 1. txt.host present → {protocol}://{txtHost}{path}  (public/tunnel URL, no port)
      // 2. fallback         → LAN direct
      let apiUrl: string;
      let lanUrl: string | undefined;
      if (txtHost) {
        // A TXT-advertised public host must (a) parse as a valid hostname,
        // (b) not collapse back onto loopback/link-local, and (c) use HTTPS
        // — clear-text traffic to a non-LAN host is never legitimate here.
        if (!isValidHostname(txtHost) || isLoopbackOrLinkLocal(txtHost)) {
          logger.warn(`[Discovery] Rejected ${service.name}: invalid txt.host "${txtHost}"`);
          return;
        }
        if (protocol !== 'https') {
          logger.warn(`[Discovery] Rejected ${service.name}: txt.host requires https`);
          return;
        }
        apiUrl = `${protocol}://${txtHost}${path}`;
        lanUrl = lanRaw; // LAN available as separate option
      } else {
        // LAN only — http allowed only for local network addresses
        const isLocal = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(localHost)
          || /\.local\.?$/.test(localHost);
        if (protocol === 'http' && !isLocal) {
          logger.warn(`[Discovery] Rejected ${service.name}: http only allowed for local addresses`);
          return;
        }
        apiUrl = lanRaw;
      }

      // Build onion URL from TXT record if present. Must be a v3 onion (56
      // base32 chars) — drop the field if malformed rather than rejecting
      // the whole record, since LAN + onion are independent transports.
      let onionUrl: string | undefined;
      if (onion) {
        if (isValidOnionAddress(onion)) {
          const onionHost = onion.endsWith('.onion') ? onion : `${onion}.onion`;
          onionUrl = `http://${onionHost}${path}`;
        } else {
          logger.warn(`[Discovery] Dropping invalid onion address for ${service.name}: "${onion}"`);
        }
      }

      const ds: DiscoveredServer = {
        name: service.name,
        host: localHost,
        port,
        apiUrl,
        lanUrl,
        onionUrl,
        isSecure: protocol === 'https',
        txtRecord: txt,
      };

      this.discovered.set(service.name, ds);
      this.notifyListeners();
    });

    this.zc.on('remove', (name: string) => {
      logger.info(`[Discovery] Removed: ${name}`);
      this.discovered.delete(name);
      this.notifyListeners();
    });

    this.zc.on('error', (err: any) => {
      logger.warn(`[Discovery] Error: ${err?.message || err}`);
    });

    this.zc.scan('tillit', 'tcp', 'local.');
    logger.info('[Discovery] Scan started for _tillit._tcp.');
  }

  stopScan(): void {
    if (!this.scanning || !this.zc) return;

    try {
      this.zc.stop();
      this.zc.removeAllListeners();
    } catch {
      // ignore cleanup errors
    }

    this.zc = null;
    this.scanning = false;
    this.discovered.clear();
    logger.info('[Discovery] Scan stopped');
  }

  getDiscovered(): DiscoveredServer[] {
    return Array.from(this.discovered.values());
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    // Send current state immediately
    listener(this.getDiscovered());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const servers = this.getDiscovered();
    for (const listener of this.listeners) {
      listener(servers);
    }
  }
}

export const discoveryService = new DiscoveryService();