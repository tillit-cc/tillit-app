/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@/components/(.*)$': '<rootDir>/src/components/$1',
    '^@/stores/(.*)$': '<rootDir>/src/stores/$1',
    '^@/hooks/(.*)$': '<rootDir>/src/hooks/$1',
    '^@/services/(.*)$': '<rootDir>/src/services/$1',
    '^@/db/(.*)$': '<rootDir>/src/db/$1',
    '^@/crypto/(.*)$': '<rootDir>/src/crypto/$1',
    '^@/types/(.*)$': '<rootDir>/src/types/$1',
    '^@/config/(.*)$': '<rootDir>/src/config/$1',
    '^@/utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@/i18n$': '<rootDir>/src/i18n/index.ts',
    '^@/i18n/(.*)$': '<rootDir>/src/i18n/$1',
    '^@/__tests__/(.*)$': '<rootDir>/src/__tests__/$1',
    '^signal-protocol$': '<rootDir>/__mocks__/signal-protocol.ts',
    '^tor-proxy$': '<rootDir>/__mocks__/tor-proxy.ts',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
    '^expo-haptics$': '<rootDir>/__mocks__/expo-haptics.ts',
    '^expo-file-system$': '<rootDir>/__mocks__/expo-file-system.ts',
    '^@/(.*)$': '<rootDir>/$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|socket\\.io-client|engine\\.io-client|drizzle-orm|zustand|immer|nativewind|axios)',
  ],
  collectCoverageFrom: [
    'src/services/**/*.ts',
    'src/utils/**/*.ts',
    '!**/*.d.ts',
    '!**/index.ts',
  ],
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.test.tsx',
  ],
};
