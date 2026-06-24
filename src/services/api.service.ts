import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { torAxiosAdapter } from './tor-axios-adapter';
import type {
  LinkInitRequest,
  LinkInitResponse,
  LinkSharePubkeyRequest,
  LinkSharePubkeyResponse,
  LinkCompleteRequest,
  LinkCompleteResponse,
  LinkSessionResultResponse,
  DeviceListResponse,
  DeviceRevokeResponse,
} from '@/types/device';

/**
 * Token storage key per server: `token_server_{serverId}`
 */
function tokenKey(serverId: number): string {
  return `token_server_${serverId}`;
}

export class ApiService {
  private client: AxiosInstance;
  private token: string | null = null;
  private readonly tokenStorageKey: string;

  public readonly useTor: boolean;
  public readonly baseUrl: string;

  constructor(
    public readonly serverId: number,
    baseUrl: string,
    useTor: boolean = false,
  ) {
    this.tokenStorageKey = tokenKey(serverId);
    this.useTor = useTor;
    this.baseUrl = baseUrl;

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // If this is a Tor server, replace the adapter entirely.
    // All requests from this client go through the native Tor SOCKS proxy,
    // bypassing XMLHttpRequest and iOS App Transport Security completely.
    if (useTor) {
      this.client.defaults.adapter = torAxiosAdapter;
    }

    // Request interceptor to add auth token
    this.client.interceptors.request.use(
      async (config) => {
        const token = await this.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && error.response?.data?.error !== 'BANNED') {
          await this.clearToken();
        }
        return Promise.reject(error);
      }
    );
  }

  // Token management
  async getToken(): Promise<string | null> {
    if (this.token) return this.token;
    try {
      this.token = await SecureStore.getItemAsync(this.tokenStorageKey);
      return this.token;
    } catch {
      return null;
    }
  }

  async setToken(token: string): Promise<void> {
    this.token = token;
    await SecureStore.setItemAsync(this.tokenStorageKey, token);
  }

  async clearToken(): Promise<void> {
    this.token = null;
    await SecureStore.deleteItemAsync(this.tokenStorageKey);
  }

  // Parse JWT token
  parseToken(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1]));
      return payload;
    } catch {
      return null;
    }
  }

  async getTokenPayload(): Promise<any | null> {
    const token = await this.getToken();
    if (!token) return null;
    return this.parseToken(token);
  }

  // Generic request methods
  async get<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get(path, config);
    return response.data;
  }

  async post<T>(path: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.post(path, data, config);
    return response.data;
  }

  async put<T>(path: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.put(path, data, config);
    return response.data;
  }

  async delete<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.delete(path, config);
    return response.data;
  }

  // Auth endpoints - Challenge-response with identity key
  async requestChallenge(identityPublicKey: string): Promise<{ challengeId: string; nonce: string }> {
    return this.post('/auth/challenge', { identityPublicKey });
  }

  async authenticateWithIdentity(payload: {
    identityPublicKey: string;
    registrationId: number;
    deviceId: number;
    signedPreKeyPublicKey: string;
    signedPreKeyId: number;
    signedPreKeySignature: string;
    challengeId: string;
    challengeSignature: string;
    // ADR-0010: per-device server-auth signature over the SAME challenge
    // message as `challengeSignature`. Required once the device has a
    // registered device-auth key; optional during transition mode.
    deviceAuthSignature?: string;
  }): Promise<{ accessToken: string; userId: number; isNewUser: boolean; banned?: boolean }> {
    return this.post('/auth/identity', payload);
  }

  async registerPushToken(token: string, platform: 'ios' | 'android', lang: string): Promise<void> {
    return this.post('/auth/token/push', { token, platform, lang });
  }

  async logout(): Promise<void> {
    await this.clearToken();
  }

  async deleteAccount(): Promise<{ success: boolean; deleted?: Record<string, unknown> }> {
    return this.delete('/auth/account');
  }

  // Chat/Room endpoints
  async createRoom(name: string, username?: string, administered?: boolean): Promise<{ roomId: number; inviteCode: string }> {
    return this.put('/chat', { name, username, administered });
  }

  async joinRoom(inviteCode: string, username?: string): Promise<any> {
    return this.post(`/chat/${inviteCode}`, { username });
  }

  async deleteRoom(roomId: number): Promise<{ action?: string }> {
    return this.delete(`/chat/${roomId}`);
  }

  async deleteMessage(roomId: number, messageId: string): Promise<void> {
    return this.delete(`/chat/${roomId}/message/${messageId}`);
  }

  async updateRoom(roomId: number, updates: { name?: string }): Promise<{ name: string }> {
    return this.put(`/chat/${roomId}`, updates);
  }

  async getRoomMembers(roomId: number): Promise<any[]> {
    const res = await this.get<any>(`/chat/${roomId}/members`);
    return res?.members ?? [];
  }

  async updateProfile(roomId: number, data: { username?: string }): Promise<void> {
    return this.put(`/chat/${roomId}/profile`, data);
  }

  async getRoomMetadata(roomId: number): Promise<any> {
    return this.get(`/chat/${roomId}/metadata`);
  }

  async getAllRooms(): Promise<{ rooms: any[] }> {
    return this.get('/chat');
  }

  // Key management endpoints
  async syncPublicKeys(payload: any): Promise<void> {
    return this.post('/keys', payload);
  }

  async getKeyStatus(): Promise<any> {
    return this.get('/keys/status/self');
  }

  async getRemoteKeys(userId: string): Promise<any> {
    return this.get(`/keys/${userId}`);
  }

  // Sender key endpoints
  async uploadSenderKeyDistribution(
    roomId: number,
    distributionId: string,
    distributions: Array<{ recipientUserId: number; recipientDeviceId: number; encryptedSenderKey: string }>
  ): Promise<void> {
    return this.post(`sender-keys/distribute/${roomId}`, {
      distributionId,
      distributions,
    });
  }

  async fetchPendingSenderKeys(roomId: number): Promise<any> {
    return this.get(`sender-keys/${roomId}`);
  }

  // Media endpoints
  async uploadMedia(
    roomId: number,
    encryptedBase64: string,
    mimeType: string
  ): Promise<{ mediaId: string; size: number; expiresAt: number }> {
    return this.post('/media', { roomId, data: encryptedBase64, mimeType });
  }

  async uploadEphemeralMedia(
    roomId: number,
    encryptedBase64: string,
    mimeType: string,
    ttlHours: number = 24
  ): Promise<{ mediaId: string; size: number; expiresAt: number }> {
    return this.post('/media/ephemeral', { roomId, data: encryptedBase64, mimeType, ttlHours });
  }

  async downloadMedia(mediaId: string): Promise<ArrayBuffer> {
    const response = await this.client.get(`/media/${mediaId}`, {
      responseType: 'arraybuffer',
    });
    return response.data;
  }

  async deleteMedia(mediaId: string): Promise<void> {
    return this.delete(`/media/${mediaId}`);
  }

  async viewedMedia(mediaId: string): Promise<void> {
    return this.post(`/media/${mediaId}/viewed`);
  }

  // Moderation endpoints
  async report(data: {
    reportedUserId: number;
    roomId: number;
    messageId?: string | null;
    reason: 'spam' | 'harassment' | 'illegal_content' | 'other';
    description?: string;
  }): Promise<{ success: boolean; reportId: number }> {
    return this.post('/moderation/report', data);
  }

  // Multi-device linking endpoints — see _shared/api/multi-device-linking.md (v2 + v2.1 proposed).
  // Backend wire v2 tracked in _shared/tasks/backend-0006-pairing-flip.md.
  // Backend wire v2.1 (share-pubkey) tracked in _shared/tasks/backend-0008-symmetric-safety-number.md.

  /** New device side. Anonymous. Open a new pairing session with the device's ephemeral pub. */
  async linkInit(payload: LinkInitRequest): Promise<LinkInitResponse> {
    return this.post('/auth/devices/link/init', payload);
  }

  /**
   * Primary side (wire v2.1). Deposits `P_pub` on the session so the new
   * device can compute its SN before the primary commits with /complete.
   * Idempotent: re-call with the same `primaryEphemeralPublicKey` is a
   * no-op; a different value yields 409 `PUBKEY_MISMATCH`.
   */
  async linkSharePubkey(payload: LinkSharePubkeyRequest): Promise<LinkSharePubkeyResponse> {
    return this.post('/auth/devices/link/share-pubkey', payload);
  }

  /**
   * Primary side. Deposit the encrypted provisioning payload. Requires
   * the session to be in `pubkey-shared` state (i.e. /share-pubkey must
   * have run first in wire v2.1).
   */
  async linkComplete(payload: LinkCompleteRequest): Promise<LinkCompleteResponse> {
    return this.post('/auth/devices/link/complete', payload);
  }

  /** New device side. Anonymous (sessionId-authorized). One-time-use: marks the session consumed. */
  async linkSessionResult(sessionId: string): Promise<LinkSessionResultResponse> {
    return this.get(`/auth/devices/link/session/${encodeURIComponent(sessionId)}/result`);
  }

  /** Primary side. Lists devices belonging to the authenticated user. */
  async listDevices(): Promise<DeviceListResponse> {
    return this.get('/auth/devices');
  }

  /** Primary side. Revoke a linked device (cannot revoke the primary itself). */
  async revokeDevice(deviceId: number): Promise<DeviceRevokeResponse> {
    return this.delete(`/auth/devices/${deviceId}`);
  }

  /** Either side. Self-revoke the current device (logout + cleanup). */
  async revokeMyDevice(): Promise<DeviceRevokeResponse> {
    return this.delete('/auth/devices/me');
  }

  // Auth status check (no JWT guard on server)
  async checkAuthStatus(): Promise<'ok' | 'banned' | 'unauthorized' | 'offline'> {
    try {
      const response = await this.client.get('/auth/status', { timeout: 5000 });
      return response.data?.status || 'ok';
    } catch (error: any) {
      if (error.response?.status === 401) {
        return error.response?.data?.error === 'BANNED' ? 'banned' : 'unauthorized';
      }
      return 'offline';
    }
  }
}
