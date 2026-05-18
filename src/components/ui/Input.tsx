import React from 'react';
import { View, TextInput, Text, TextInputProps } from 'react-native';

interface InputProps extends Omit<TextInputProps, 'className'> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  containerClassName?: string;
  inputClassName?: string;
}

export function Input({
  label,
  error,
  helperText,
  leftIcon,
  rightIcon,
  containerClassName = '',
  inputClassName = '',
  ...props
}: InputProps) {
  const hasError = !!error;

  return (
    <View className={containerClassName}>
      {label && (
        <Text className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </Text>
      )}

      <View
        className={`flex-row items-center rounded-xl bg-gray-100 dark:bg-gray-800 px-4 ${
          hasError ? 'border-2 border-red-500' : 'border border-transparent'
        }`}
      >
        {leftIcon && <View className="mr-2">{leftIcon}</View>}

        <TextInput
          className={`flex-1 py-3 text-base text-gray-900 dark:text-white ${inputClassName}`}
          placeholderTextColor="#9ca3af"
          {...props}
        />

        {rightIcon && <View className="ml-2">{rightIcon}</View>}
      </View>

      {(error || helperText) && (
        <Text
          className={`mt-1.5 text-sm ${
            hasError ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {error || helperText}
        </Text>
      )}
    </View>
  );
}
