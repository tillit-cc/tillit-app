import { requireNativeViewManager } from 'expo-modules-core';
import { ViewProps } from 'react-native';

const NativeSecureView: React.ComponentType<ViewProps> =
  requireNativeViewManager('SecureView');

export function SecureView(props: ViewProps & { children?: React.ReactNode }) {
  return <NativeSecureView {...props} />;
}
