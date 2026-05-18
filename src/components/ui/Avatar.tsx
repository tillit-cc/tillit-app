import React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';

interface AvatarProps {
  uri?: string | null;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  userId?: number;
  className?: string;
}

/**
 * Generate a consistent color based on user ID
 * Uses the golden angle for uniform distribution
 */
function getUserColor(userId: number): string {
  if (!userId) return '#6b7280'; // gray-500

  const hue = (userId * 137.508) % 360;
  // Convert HSL to hex (simplified)
  const h = hue / 360;
  const s = 0.5;
  const l = 0.4;

  const hueToRgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(p, q, h) * 255);
  const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);

  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Get initials from a name
 */
function getInitials(name: string): string {
  if (!name) return '?';

  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }

  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function Avatar({ uri, name, size = 'md', userId, className = '' }: AvatarProps) {
  const sizeClasses = {
    xs: 'w-6 h-6',
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
  };

  const textSizeClasses = {
    xs: 'text-xs',
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
    xl: 'text-2xl',
  };

  const sizePx = {
    xs: 24,
    sm: 32,
    md: 40,
    lg: 48,
    xl: 64,
  };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        className={`rounded-full ${sizeClasses[size]} ${className}`}
        contentFit="cover"
        transition={200}
      />
    );
  }

  const backgroundColor = userId ? getUserColor(userId) : '#6b7280';
  const initials = getInitials(name || '');

  return (
    <View
      className={`rounded-full items-center justify-center ${sizeClasses[size]} ${className}`}
      style={{ backgroundColor }}
    >
      <Text className={`font-semibold text-white ${textSizeClasses[size]}`}>{initials}</Text>
    </View>
  );
}
