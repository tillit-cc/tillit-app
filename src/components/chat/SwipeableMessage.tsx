import React, { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const SWIPE_THRESHOLD = 80;
const MAX_TRANSLATE = 100;

interface SwipeableMessageProps {
  children: React.ReactNode;
  onReply: () => void;
}

export const SwipeableMessage = React.memo(function SwipeableMessage({
  children,
  onReply,
}: SwipeableMessageProps) {
  const translateX = useSharedValue(0);
  const hasTriggeredHaptic = useSharedValue(false);

  const triggerHaptic = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const triggerReply = useCallback(() => {
    onReply();
  }, [onReply]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([0, 20])
    .failOffsetY([-10, 10])
    .failOffsetX(-1)
    .onUpdate((event) => {
      const clampedX = Math.min(Math.max(event.translationX, 0), MAX_TRANSLATE);
      translateX.value = clampedX;

      if (clampedX >= SWIPE_THRESHOLD && !hasTriggeredHaptic.value) {
        hasTriggeredHaptic.value = true;
        scheduleOnRN(triggerHaptic);
      } else if (clampedX < SWIPE_THRESHOLD) {
        hasTriggeredHaptic.value = false;
      }
    })
    .onEnd(() => {
      if (translateX.value >= SWIPE_THRESHOLD) {
        scheduleOnRN(triggerReply);
      }
      translateX.value = withTiming(0, { duration: 150 });
      hasTriggeredHaptic.value = false;
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const iconStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateX.value,
      [0, SWIPE_THRESHOLD * 0.5, SWIPE_THRESHOLD],
      [0, 0.5, 1],
      Extrapolation.CLAMP,
    );
    const scale = interpolate(
      translateX.value,
      [0, SWIPE_THRESHOLD * 0.5, SWIPE_THRESHOLD],
      [0.5, 0.75, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity,
      transform: [{ scale }],
    };
  });

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View>
        <Animated.View style={[styles.iconContainer, iconStyle]}>
          <Ionicons name="arrow-undo" size={20} color="#9ca3af" />
        </Animated.View>
        <Animated.View style={animatedStyle}>
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  iconContainer: {
    position: 'absolute',
    left: 8,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    width: 32,
  },
});
