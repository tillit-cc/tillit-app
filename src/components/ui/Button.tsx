import React from 'react';
import { Pressable, Text, ActivityIndicator, View } from 'react-native';

interface ButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  className?: string;
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  iconPosition = 'left',
  className = '',
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const baseClasses = 'flex-row items-center justify-center rounded-xl';

  const variantClasses = {
    primary: 'bg-primary-400 active:bg-primary-600',
    secondary: 'bg-gray-200 dark:bg-gray-700 active:bg-gray-300 dark:active:bg-gray-600',
    outline: 'border-2 border-primary-400 bg-transparent active:bg-primary-50 dark:active:bg-primary-900/20',
    ghost: 'bg-transparent active:bg-gray-100 dark:active:bg-gray-800',
    danger: 'bg-red-500 active:bg-red-600',
  };

  const sizeClasses = {
    sm: 'px-3 py-2',
    md: 'px-4 py-3',
    lg: 'px-6 py-4',
  };

  const textVariantClasses = {
    primary: 'text-white',
    secondary: 'text-gray-800 dark:text-gray-200',
    outline: 'text-primary-400',
    ghost: 'text-gray-800 dark:text-gray-200',
    danger: 'text-white',
  };

  const textSizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  const disabledClasses = isDisabled ? 'opacity-50' : '';

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${disabledClasses} ${className}`}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' || variant === 'danger' ? '#fff' : '#2ad1af'}
        />
      ) : (
        <>
          {icon && iconPosition === 'left' && <View className="mr-2">{icon}</View>}
          <Text
            className={`font-semibold ${textVariantClasses[variant]} ${textSizeClasses[size]}`}
          >
            {children}
          </Text>
          {icon && iconPosition === 'right' && <View className="ml-2">{icon}</View>}
        </>
      )}
    </Pressable>
  );
}
