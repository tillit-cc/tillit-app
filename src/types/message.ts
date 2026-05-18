import { getRandomValues } from 'expo-crypto';

// Message status enum
export const MessageStatus = {
  UNDELIVERED: -2,
  FAILED: -1,
  PENDING: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
} as const;

export type MessageStatusType = typeof MessageStatus[keyof typeof MessageStatus];

// Result returned by send methods to propagate final status to callers
export type SendResult = { messageId: string; status: MessageStatusType };

// User message types
export const UserMessageType = {
  TEXT: 'text',
  IMAGE: 'image',
  PERSISTENT_IMAGE: 'persistent_image',
  EPHEMERAL_IMAGE: 'ephemeral_image',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file',
  LOCATION: 'location',
} as const;

export type UserMessageTypeValue = typeof UserMessageType[keyof typeof UserMessageType];

// Control packet types
export const ControlPacketType = {
  MESSAGE_DELIVERED: 'delivered',
  MESSAGE_READ: 'read',
  PROFILE_UPDATED: 'profile_updated',
  SESSION_ESTABLISHED: 'session_established',
  TYPING_STARTED: 'typing_start',
  TYPING_STOPPED: 'typing_stop',
} as const;

export type ControlPacketTypeValue = typeof ControlPacketType[keyof typeof ControlPacketType];

// Message envelope (matches backend format)
export interface MessageEnvelope {
  id: string;
  timestamp: number;
  category: 'user' | 'senderkey_message' | 'system' | 'action' | 'control';
  type: string;
  payload: any;
  id_room: number;
  id_user_from: number;
  device_id_from?: number;
  id_user_to?: number;
  encrypted?: boolean;
  target_message_id?: string;
  id_parent?: string;
  version?: string;
}

// Image message payload
export interface ImageMessagePayload {
  base64: string;
  mimeType?: string;
  width?: number;
  height?: number;
  size?: number;
  thumbnail?: string;
}

// Persistent image message payload (server-stored, AES-encrypted)
export interface PersistentImagePayload {
  mediaId: string;
  mediaKey: string;
  iv: string;
  thumbnail: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

// Ephemeral image message payload (self-destructing, AES-encrypted)
export interface EphemeralImagePayload extends PersistentImagePayload {
  viewDuration: number; // seconds: 5 | 10 | 30
}

// Audio message payload
export interface AudioMessagePayload {
  base64: string;
  mimeType?: string;
  duration?: number;
  size?: number;
}

// File message payload (server-stored, AES-encrypted document)
// Mirror of PersistentImagePayload but for arbitrary file types.
// `ephemeral` and `expiresAt` are populated when the upload used /media/ephemeral.
export interface FileMessagePayload {
  mediaId: string;
  mediaKey: string;
  iv: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  ephemeral?: boolean;
  expiresAt?: number;
}

// Text message payload
export interface TextMessagePayload {
  text: string;
}

// Location message payload
export interface LocationMessagePayload {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

// Generate UUID using cryptographic PRNG
export function generateUUID(): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // Set version 4 (0100) in byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant 10xx in byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Generate a temporary local ID (prefixed so it's distinguishable from server UUIDs)
export function generateLocalId(): string {
  return `local_${generateUUID()}`;
}

// Message envelope factory
export const MessageEnvelopeFactory = {
  createTextMessage(
    roomId: number,
    userId: number,
    text: string,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.TEXT,
      payload: { text },
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createImageMessage(
    roomId: number,
    userId: number,
    imagePayload: ImageMessagePayload,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.IMAGE,
      payload: imagePayload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createPersistentImageMessage(
    roomId: number,
    userId: number,
    payload: PersistentImagePayload,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.PERSISTENT_IMAGE,
      payload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createEphemeralImageMessage(
    roomId: number,
    userId: number,
    payload: EphemeralImagePayload,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.EPHEMERAL_IMAGE,
      payload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createFileMessage(
    roomId: number,
    userId: number,
    payload: FileMessagePayload,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.FILE,
      payload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createAudioMessage(
    roomId: number,
    userId: number,
    audioPayload: AudioMessagePayload,
    options: { id_parent?: string; encrypted?: boolean } = {}
  ): MessageEnvelope {
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'user',
      type: UserMessageType.AUDIO,
      payload: audioPayload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: options.encrypted ?? true,
      id_parent: options.id_parent,
      version: '2.0',
    };
  },

  createControlPacket(
    roomId: number,
    userId: number,
    type: ControlPacketTypeValue,
    payload: any
  ): MessageEnvelope {
    // SESSION_ESTABLISHED MUST be encrypted: the receiver decrypts the
    // PreKeySignalMessage which auto-establishes the reverse session via X3DH.
    // The joiner has already called establishSession() so can encrypt.
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      category: 'control',
      type,
      payload,
      id_room: roomId,
      id_user_from: userId,
      encrypted: true,
      version: '2.0',
    };
  },
};
