import * as SecureStore from 'expo-secure-store';

// --- Axios mock setup ---
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
}));

import axios from 'axios';
import { ApiService } from './api.service';

// Type helpers for interceptor callbacks
type RequestFulfilled = (config: any) => Promise<any>;
type RequestRejected = (error: any) => Promise<any>;
type ResponseFulfilled = (response: any) => any;
type ResponseRejected = (error: any) => Promise<any>;

describe('ApiService', () => {
  let api: ApiService;
  let requestFulfilled: RequestFulfilled;
  let requestRejected: RequestRejected;
  let responseFulfilled: ResponseFulfilled;
  let responseRejected: ResponseRejected;

  beforeEach(() => {
    jest.clearAllMocks();
    (SecureStore as any).__reset();

    api = new ApiService(1, 'https://api.test.com');

    // Capture interceptor callbacks registered during construction
    requestFulfilled = mockAxiosInstance.interceptors.request.use.mock.calls[0][0];
    requestRejected = mockAxiosInstance.interceptors.request.use.mock.calls[0][1];
    responseFulfilled = mockAxiosInstance.interceptors.response.use.mock.calls[0][0];
    responseRejected = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];
  });

  // 1. Constructor creates axios instance with correct baseURL and timeout
  describe('constructor', () => {
    it('creates axios instance with correct baseURL and timeout', () => {
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.test.com',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    it('registers request and response interceptors', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
    });
  });

  // 2. Request interceptor adds Bearer token when token exists
  describe('request interceptor', () => {
    it('adds Bearer token when token exists', async () => {
      await api.setToken('my-jwt-token');

      const config = { headers: {} as Record<string, string> };
      const result = await requestFulfilled(config);

      expect(result.headers.Authorization).toBe('Bearer my-jwt-token');
    });

    // 3. Request interceptor skips Authorization when no token
    it('skips Authorization header when no token', async () => {
      const config = { headers: {} as Record<string, string> };
      const result = await requestFulfilled(config);

      expect(result.headers.Authorization).toBeUndefined();
    });

    it('rejects on error', async () => {
      const error = new Error('request error');
      await expect(requestRejected(error)).rejects.toThrow('request error');
    });
  });

  // 4. Response interceptor passes through successful responses
  describe('response interceptor', () => {
    it('passes through successful responses', () => {
      const response = { status: 200, data: { ok: true } };
      expect(responseFulfilled(response)).toEqual(response);
    });

    // 5. Response interceptor calls clearToken on 401 error
    it('calls clearToken on 401 error', async () => {
      await api.setToken('should-be-cleared');

      const error = { response: { status: 401 } };
      await expect(responseRejected(error)).rejects.toEqual(error);

      // Token should be cleared from memory and SecureStore
      const storedToken = await SecureStore.getItemAsync('token_server_1');
      expect(storedToken).toBeNull();
    });

    it('does not clear token on non-401 errors', async () => {
      await api.setToken('should-remain');

      const error = { response: { status: 500 } };
      await expect(responseRejected(error)).rejects.toEqual(error);

      const storedToken = await SecureStore.getItemAsync('token_server_1');
      expect(storedToken).toBe('should-remain');
    });
  });

  // 6-8. Token management
  describe('getToken', () => {
    // 6. Returns cached token if available
    it('returns cached token if available', async () => {
      await api.setToken('cached-token');

      const token = await api.getToken();
      expect(token).toBe('cached-token');
    });

    // 7. Reads from SecureStore if not cached
    it('reads from SecureStore if not cached in memory', async () => {
      // Simulate a token in SecureStore but not in the instance's memory cache
      await SecureStore.setItemAsync('token_server_1', 'stored-token');

      // Create a fresh instance — memory cache is empty
      const freshApi = new ApiService(1, 'https://api.test.com');
      const token = await freshApi.getToken();

      expect(token).toBe('stored-token');
    });

    // 8. Returns null if SecureStore is empty
    it('returns null if SecureStore is empty', async () => {
      const freshApi = new ApiService(1, 'https://api.test.com');
      const token = await freshApi.getToken();

      expect(token).toBeNull();
    });
  });

  // 9. setToken: saves to memory and SecureStore
  describe('setToken', () => {
    it('saves to memory and SecureStore', async () => {
      await api.setToken('new-token');

      // Memory cache — subsequent getToken should return without hitting SecureStore
      const token = await api.getToken();
      expect(token).toBe('new-token');

      // SecureStore
      const storedToken = await SecureStore.getItemAsync('token_server_1');
      expect(storedToken).toBe('new-token');
    });

    it('uses server-specific storage key', async () => {
      const api2 = new ApiService(2, 'https://api2.test.com');
      await api2.setToken('server2-token');

      const stored1 = await SecureStore.getItemAsync('token_server_1');
      const stored2 = await SecureStore.getItemAsync('token_server_2');
      expect(stored1).toBeNull();
      expect(stored2).toBe('server2-token');
    });
  });

  // 10. clearToken: clears memory and SecureStore
  describe('clearToken', () => {
    it('clears memory and SecureStore', async () => {
      await api.setToken('to-be-cleared');
      await api.clearToken();

      // Memory cache cleared — getToken must go to SecureStore and find nothing
      const token = await api.getToken();
      expect(token).toBeNull();

      const storedToken = await SecureStore.getItemAsync('token_server_1');
      expect(storedToken).toBeNull();
    });
  });

  // 11-12. parseToken
  describe('parseToken', () => {
    // 11. Parses valid JWT payload
    it('parses valid JWT payload', () => {
      const payload = { userId: 42, exp: 1700000000 };
      const encodedPayload = btoa(JSON.stringify(payload));
      const fakeJwt = `header.${encodedPayload}.signature`;

      const result = api.parseToken(fakeJwt);
      expect(result).toEqual(payload);
    });

    // 12. Returns null for invalid token
    it('returns null for token with wrong number of parts', () => {
      expect(api.parseToken('not-a-jwt')).toBeNull();
      expect(api.parseToken('only.two')).toBeNull();
    });

    it('returns null for token with invalid base64 payload', () => {
      expect(api.parseToken('a.!!!invalid-base64!!!.c')).toBeNull();
    });

    it('returns null for token with non-JSON payload', () => {
      const encoded = btoa('this is not json');
      expect(api.parseToken(`a.${encoded}.c`)).toBeNull();
    });
  });

  // 13. get/post/put/delete: delegate to axios and return response.data
  describe('HTTP methods', () => {
    it('get delegates to axios and returns response.data', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { items: [1, 2, 3] } });

      const result = await api.get('/test-path');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/test-path', undefined);
      expect(result).toEqual({ items: [1, 2, 3] });
    });

    it('get passes config to axios', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: 'ok' });
      const config = { params: { page: 1 } };

      await api.get('/path', config);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/path', config);
    });

    it('post delegates to axios and returns response.data', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 1 } });

      const result = await api.post('/test-path', { name: 'test' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/test-path', { name: 'test' }, undefined);
      expect(result).toEqual({ id: 1 });
    });

    it('put delegates to axios and returns response.data', async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({ data: { updated: true } });

      const result = await api.put('/test-path', { field: 'value' });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/test-path', { field: 'value' }, undefined);
      expect(result).toEqual({ updated: true });
    });

    it('delete delegates to axios and returns response.data', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({ data: { deleted: true } });

      const result = await api.delete('/test-path');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/test-path', undefined);
      expect(result).toEqual({ deleted: true });
    });
  });

  // 14. requestChallenge: calls post with correct path and payload
  describe('requestChallenge', () => {
    it('calls post with correct path and payload', async () => {
      const challengeResponse = { challengeId: 'ch-123', nonce: 'abc-nonce' };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: challengeResponse });

      const result = await api.requestChallenge('my-identity-public-key');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/auth/challenge',
        { identityPublicKey: 'my-identity-public-key' },
        undefined,
      );
      expect(result).toEqual(challengeResponse);
    });
  });

  // ADR-0010: per-device server-auth credential
  describe('authenticateWithIdentity', () => {
    it('forwards deviceAuthSignature in the /auth/identity body', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { accessToken: 'a.b.c', userId: 7, isNewUser: false },
      });

      await api.authenticateWithIdentity({
        identityPublicKey: 'idpub',
        registrationId: 1,
        deviceId: 1,
        signedPreKeyPublicKey: 'spk',
        signedPreKeyId: 2,
        signedPreKeySignature: 'sig',
        challengeId: 'ch-1',
        challengeSignature: 'csig',
        deviceAuthSignature: 'dasig',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/auth/identity',
        expect.objectContaining({
          challengeSignature: 'csig',
          deviceAuthSignature: 'dasig',
        }),
        undefined,
      );
    });
  });

});
