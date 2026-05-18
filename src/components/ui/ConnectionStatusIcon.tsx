import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useServerStore } from '@/stores/server.store';
import { SocketConnectionState } from '@/types/connection';
import { isOnionUrl } from '@/services/tor-axios-adapter';

interface ConnectionStatusIconProps {
  size?: number;
  onPress?: () => void;
}

/**
 * TilliT logo icon that changes color based on socket connection state.
 * Derives state from server.store (multi-server aware).
 * - All disconnected (CLOSED): Shows red alert icon
 * - All connected: Shows teal TilliT logo
 * - Mixed (some connecting/closed): Shows grey TilliT logo
 */
export function ConnectionStatusIcon({ size = 26, onPress }: ConnectionStatusIconProps) {
  const connectionStates = useServerStore((s) => s.connectionStates);
  const servers = useServerStore((s) => s.servers);

  // Check if any connected server is a Tor server
  const hasTorConnected = servers.some(
    (s) =>
      (isOnionUrl(s.apiUrl) || (s as any).isTor === 1) &&
      connectionStates.get(s.id) === SocketConnectionState.CONNECTED
  );

  // Derive aggregate state from all servers
  let allConnected = connectionStates.size > 0;
  let allClosed = connectionStates.size > 0;

  for (const state of connectionStates.values()) {
    if (state !== SocketConnectionState.CONNECTED) {
      allConnected = false;
    }
    if (state !== SocketConnectionState.CLOSED) {
      allClosed = false;
    }
  }

  // If no servers registered yet, treat as connecting
  if (connectionStates.size === 0) {
    allClosed = false;
  }

  // All disconnected - show alert icon
  if (allClosed) {
    return (
      <Pressable onPress={onPress} style={{ paddingHorizontal: 12 }} hitSlop={8}>
        <Ionicons name="alert-circle" size={size} color="#ef4444" />
      </Pressable>
    );
  }

  // Green only when ALL servers are connected, grey otherwise
  const fillColor = allConnected ? '#2ad1af' : '#9ca3af';

  return (
    <Pressable onPress={onPress} style={{ paddingHorizontal: 12, height: size }} hitSlop={8}>
      <View>
        <Svg
          width={size}
          height={size}
          viewBox="0 0 2048 2048"
        >
          {/* Outer circle */}
          <Path
            d="M1024,120a911.14,911.14,0,0,1,182.31,18.37,898.19,898.19,0,0,1,323,136A907.05,907.05,0,0,1,1857,672.16a898.24,898.24,0,0,1,52.62,169.53,913.84,913.84,0,0,1,0,364.62,898.19,898.19,0,0,1-136,323A907.05,907.05,0,0,1,1375.84,1857a898.24,898.24,0,0,1-169.53,52.62,913.84,913.84,0,0,1-364.62,0,898.19,898.19,0,0,1-323-136A907.05,907.05,0,0,1,191,1375.84a898.24,898.24,0,0,1-52.62-169.53,913.84,913.84,0,0,1,0-364.62,898.19,898.19,0,0,1,136-323A907.05,907.05,0,0,1,672.16,191a898.24,898.24,0,0,1,169.53-52.62A911.14,911.14,0,0,1,1024,120m0-120C458.46,0,0,458.46,0,1024S458.46,2048,1024,2048s1024-458.46,1024-1024S1589.54,0,1024,0Z"
            fill={fillColor}
          />
          {/* Inner "T" letter */}
          <Path
            d="M1230,1142.14q1.11-46.85,9.63-59.66t33.26-12.79q19.24,0,28.86,11.54t9.63,34q-1.11,19.37-1.11,29.35l-5.5,206.12q-1.08,23.12-11,33.44T1263,1394.5H785q-20.88,0-30.78-10.31t-10.46-33.44l-6-206.12q0-11.25-.55-21.24c-.36-6.66-.55-9.78-.55-9.36q0-22.5,10.46-33.42t31.32-10.92q22,0,30.25,12.79t9.35,59.66l5.48,162.36h158v-563h-106q-23.07,0-33.52-10.3t-10.44-32.76q0-21.86,9.89-33.39t28.55-11.55h308.12q18.69,0,28.57,11.55t9.87,33.39q0,23.09-10.7,33.08t-36.55,10H1066.49v563h158Z"
            fill="#2ad1af"
          />
        </Svg>
        {/* Tor shield overlay badge */}
        {hasTorConnected && (
          <View style={{
            position: 'absolute',
            bottom: -2,
            right: -4,
            backgroundColor: '#9333ea',
            borderRadius: 6,
            width: 12,
            height: 12,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Ionicons name="shield-half-outline" size={8} color="#ffffff" />
          </View>
        )}
      </View>
    </Pressable>
  );
}
