import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  Switch,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { seedDemoData, clearSeedData, SeedConfig } from '@/services/seed.service';
import { logger } from '@/utils/logger';

interface DeveloperToolsModalProps {
  visible: boolean;
  onClose: () => void;
}

type SeedingState = 'idle' | 'seeding' | 'clearing' | 'done' | 'error';

function NumericStepper({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
}) {
  const decrement = () => onChange(Math.max(min, value - step));
  const increment = () => onChange(Math.min(max, value + step));

  return (
    <View className="flex-row items-center justify-between mb-4">
      <Text className="text-sm text-gray-700 dark:text-gray-300 flex-1">{label}</Text>
      <View className="flex-row items-center" style={{ gap: 8 }}>
        <TouchableOpacity
          onPress={decrement}
          disabled={disabled || value <= min}
          className="w-8 h-8 rounded-lg items-center justify-center"
          style={{ backgroundColor: disabled || value <= min ? '#e5e7eb' : '#2ad1af' }}
        >
          <Ionicons name="remove" size={18} color={disabled || value <= min ? '#9ca3af' : '#fff'} />
        </TouchableOpacity>
        <Text className="text-sm font-semibold text-gray-900 dark:text-white w-12 text-center">
          {value}
        </Text>
        <TouchableOpacity
          onPress={increment}
          disabled={disabled || value >= max}
          className="w-8 h-8 rounded-lg items-center justify-center"
          style={{ backgroundColor: disabled || value >= max ? '#e5e7eb' : '#2ad1af' }}
        >
          <Ionicons name="add" size={18} color={disabled || value >= max ? '#9ca3af' : '#fff'} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function DeveloperToolsModal({ visible, onClose }: DeveloperToolsModalProps) {
  const [seedServerUrl, setSeedServerUrl] = useState('http://localhost:8080');
  const [numChats, setNumChats] = useState(50);
  const [msgsPerChat, setMsgsPerChat] = useState(100);
  const [numUsers, setNumUsers] = useState(10);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [locale, setLocale] = useState<'it_IT' | 'en_US'>('it_IT');
  const [myUsername, setMyUsername] = useState('User');

  const [seedingState, setSeedingState] = useState<SeedingState>('idle');
  const [progressStep, setProgressStep] = useState('');
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [resultMessage, setResultMessage] = useState('');

  const handleProgress = useCallback((step: string, current: number, total: number) => {
    setProgressStep(step);
    setProgressCurrent(current);
    setProgressTotal(total);
  }, []);

  const handleStartSeed = useCallback(async () => {
    setSeedingState('seeding');
    setResultMessage('');
    try {
      const config: SeedConfig = {
        seedServerUrl: seedServerUrl.replace(/\/+$/, ''),
        numChats,
        msgsPerChat,
        numUsers,
        includeMedia,
        locale,
        myUsername: myUsername.trim() || undefined,
      };
      const result = await seedDemoData(config, handleProgress);
      setResultMessage(`Seeded ${result.roomCount} rooms, ${result.messageCount} messages`);
      setSeedingState('done');
    } catch (error: any) {
      logger.error(`[Seed] Error: ${error?.message}`);
      setResultMessage(`Error: ${error?.message || 'Unknown error'}`);
      setSeedingState('error');
    }
  }, [seedServerUrl, numChats, msgsPerChat, numUsers, includeMedia, locale, myUsername, handleProgress]);

  const handleClearSeed = useCallback(async () => {
    Alert.alert(
      'Clear Demo Data',
      'This will remove all seeded rooms, messages, and profiles. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setSeedingState('clearing');
            setResultMessage('');
            try {
              await clearSeedData(handleProgress);
              setResultMessage('All seed data cleared');
              setSeedingState('done');
            } catch (error: any) {
              logger.error(`[Seed] Clear error: ${error?.message}`);
              setResultMessage(`Error: ${error?.message || 'Unknown error'}`);
              setSeedingState('error');
            }
          },
        },
      ],
    );
  }, [handleProgress]);

  const handleClose = useCallback(() => {
    if (seedingState === 'seeding' || seedingState === 'clearing') return;
    setSeedingState('idle');
    setResultMessage('');
    setProgressStep('');
    onClose();
  }, [onClose, seedingState]);

  const isProcessing = seedingState === 'seeding' || seedingState === 'clearing';
  const progressPercent = progressTotal > 0 ? (progressCurrent / progressTotal) * 100 : 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView className="flex-1 bg-white dark:bg-gray-900" edges={['top']}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 pt-4 pb-2 border-b border-gray-200 dark:border-gray-700">
          <TouchableOpacity onPress={handleClose} className="p-2" disabled={isProcessing}>
            <Ionicons name="close" size={24} color={isProcessing ? '#9ca3af' : '#5d7da3'} />
          </TouchableOpacity>
          <Text className="text-lg font-semibold text-gray-900 dark:text-white">
            Developer Tools
          </Text>
          <View className="p-2" style={{ width: 40 }} />
        </View>

        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          {/* Seed Server URL */}
          <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
            Seed Server
          </Text>
          <TextInput
            value={seedServerUrl}
            onChangeText={setSeedServerUrl}
            placeholder="http://192.168.1.100:8080"
            className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-4"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isProcessing}
          />

          {/* My Username */}
          <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">
            My Username
          </Text>
          <TextInput
            value={myUsername}
            onChangeText={setMyUsername}
            placeholder="User"
            className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white mb-4"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isProcessing}
          />

          {/* Configuration */}
          <Text className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wide">
            Seed Configuration
          </Text>

          <NumericStepper
            label="Chats"
            value={numChats}
            onChange={setNumChats}
            min={10}
            max={500}
            step={10}
            disabled={isProcessing}
          />

          <NumericStepper
            label="Messages per chat"
            value={msgsPerChat}
            onChange={setMsgsPerChat}
            min={10}
            max={1000}
            step={50}
            disabled={isProcessing}
          />

          <NumericStepper
            label="Users"
            value={numUsers}
            onChange={setNumUsers}
            min={2}
            max={50}
            step={1}
            disabled={isProcessing}
          />

          {/* Include Media */}
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-sm text-gray-700 dark:text-gray-300">Include media</Text>
            <Switch
              value={includeMedia}
              onValueChange={setIncludeMedia}
              trackColor={{ false: '#d1d5db', true: '#2ad1af' }}
              thumbColor={Platform.OS === 'android' ? '#ffffff' : undefined}
              disabled={isProcessing}
            />
          </View>

          {/* Locale */}
          <View className="flex-row items-center justify-between mb-6">
            <Text className="text-sm text-gray-700 dark:text-gray-300">Locale</Text>
            <View className="flex-row" style={{ gap: 8 }}>
              {(['it_IT', 'en_US'] as const).map((loc) => (
                <TouchableOpacity
                  key={loc}
                  onPress={() => setLocale(loc)}
                  disabled={isProcessing}
                  className="rounded-lg px-3 py-1.5"
                  style={{
                    backgroundColor: locale === loc ? '#2ad1af' : '#e5e7eb',
                  }}
                >
                  <Text
                    className="text-sm font-medium"
                    style={{ color: locale === loc ? '#ffffff' : '#374151' }}
                  >
                    {loc === 'it_IT' ? 'Italiano' : 'English'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Progress */}
          {isProcessing && (
            <View className="mb-4">
              <Text className="text-sm text-gray-600 dark:text-gray-400 mb-2">{progressStep}</Text>
              <View className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <View
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(progressPercent, 100)}%`,
                    backgroundColor: '#2ad1af',
                  }}
                />
              </View>
              {progressTotal > 0 && (
                <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-right">
                  {progressCurrent} / {progressTotal}
                </Text>
              )}
            </View>
          )}

          {/* Result message */}
          {resultMessage !== '' && (
            <View
              className="rounded-xl px-4 py-3 mb-4"
              style={{
                backgroundColor: seedingState === 'error' ? '#fef2f2' : '#f0fdf4',
              }}
            >
              <Text
                className="text-sm"
                style={{
                  color: seedingState === 'error' ? '#dc2626' : '#16a34a',
                }}
              >
                {resultMessage}
              </Text>
            </View>
          )}

          {/* Action Buttons */}
          <View style={{ gap: 12 }}>
            <TouchableOpacity
              onPress={handleStartSeed}
              disabled={isProcessing || !seedServerUrl.trim()}
              className="rounded-xl py-3.5 items-center"
              style={{
                backgroundColor: isProcessing || !seedServerUrl.trim() ? '#d1d5db' : '#2ad1af',
              }}
            >
              <Text className="text-white font-semibold text-base">
                {seedingState === 'seeding' ? 'Seeding...' : 'Start Seeding'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleClearSeed}
              disabled={isProcessing}
              className="rounded-xl py-3.5 items-center"
              style={{
                backgroundColor: isProcessing ? '#d1d5db' : '#ef4444',
              }}
            >
              <Text className="text-white font-semibold text-base">
                {seedingState === 'clearing' ? 'Clearing...' : 'Clear Demo Data'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Info */}
          <Text className="text-xs text-gray-400 dark:text-gray-500 mt-4 text-center">
            Seed data is written directly to the local DB.{'\n'}
            No encryption or server connection required.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
