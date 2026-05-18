import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  Alert,
  Share,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { logger } from '@/utils/logger';

interface Member {
  id_user: number;
  username: string;
}

interface RoomDetailsModalProps {
  visible: boolean;
  roomId: number;
  currentName: string;
  currentUsername: string;
  currentUserId: number | null;
  inviteCode: string;
  administered?: number;
  roomOwnerId?: number;
  onClose: () => void;
  onUpdateName: (newName: string) => Promise<void>;
  onUpdateUsername: (newUsername: string) => Promise<void>;
  onDeleteRoom: () => void;
  onReportUser: (userId: number, username: string) => void;
  fetchMembers: () => Promise<Member[]>;
}

const MAX_NAME_LENGTH = 30;
const MAX_USERNAME_LENGTH = 20;

export function RoomDetailsModal({
  visible,
  currentName,
  currentUsername,
  currentUserId,
  inviteCode,
  administered,
  roomOwnerId,
  onClose,
  onUpdateName,
  onUpdateUsername,
  onDeleteRoom,
  onReportUser,
  fetchMembers,
}: RoomDetailsModalProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // Room name editing
  const [isEditingName, setIsEditingName] = useState(false);
  const [name, setName] = useState(currentName);
  const [isUpdatingName, setIsUpdatingName] = useState(false);

  // Username editing
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [username, setUsername] = useState(currentUsername);
  const [isUpdatingUsername, setIsUpdatingUsername] = useState(false);

  // Members
  const [members, setMembers] = useState<Member[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);

  // Only reset state when modal opens, not when props change
  useEffect(() => {
    if (visible) {
      setName(currentName);
      setUsername(currentUsername);
      setIsEditingName(false);
      setIsEditingUsername(false);
      loadMembers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const loadMembers = async () => {
    setIsLoadingMembers(true);
    try {
      const data = await fetchMembers();
      setMembers(data);
    } catch (error) {
      logger.error('[RoomDetailsModal] Failed to load members:', error);
    } finally {
      setIsLoadingMembers(false);
    }
  };

  const handleSaveName = async () => {
    if (!name.trim() || name.trim() === currentName) {
      setIsEditingName(false);
      setName(currentName);
      return;
    }

    setIsUpdatingName(true);
    try {
      await onUpdateName(name.trim());
      setIsEditingName(false);
    } catch (error) {
      logger.error('[RoomDetailsModal] Failed to update name:', error);
      setName(currentName);
    } finally {
      setIsUpdatingName(false);
    }
  };

  const handleSaveUsername = async () => {
    if (!username.trim() || username.trim() === currentUsername) {
      setIsEditingUsername(false);
      setUsername(currentUsername);
      return;
    }

    setIsUpdatingUsername(true);
    try {
      await onUpdateUsername(username.trim());
      setIsEditingUsername(false);
    } catch (error) {
      logger.error('[RoomDetailsModal] Failed to update username:', error);
      setUsername(currentUsername);
    } finally {
      setIsUpdatingUsername(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1 }}>
        <Pressable
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          onPress={onClose}
        />

        <View
          className="bg-white dark:bg-gray-900 rounded-t-3xl mt-auto"
          style={{ height: '70%', paddingBottom: insets.bottom + 16 }}
        >
          {/* Handle bar */}
          <View className="items-center pt-3 pb-2">
            <View className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
          </View>

          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
            <View className="w-10" />
            <Text className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('rooms.roomDetails')}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              className="w-10 items-end"
            >
              <Ionicons name="close" size={24} color="#9ca3af" />
            </Pressable>
          </View>

          <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            {/* Room Name Section */}
            <View className="px-4 py-4">
              <Text className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-2">
                {t('rooms.roomName')}
              </Text>

              {isEditingName ? (
                <View className="flex-row items-center gap-2">
                  <View className="flex-1 relative">
                    <TextInput
                      value={name}
                      onChangeText={(text) => setName(text.slice(0, MAX_NAME_LENGTH))}
                      placeholder={t('rooms.roomNamePlaceholder')}
                      placeholderTextColor="#9ca3af"
                      maxLength={MAX_NAME_LENGTH}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleSaveName}
                      className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white pr-12"
                    />
                    <Text className="absolute right-3 top-3 text-xs text-gray-400">
                      {name.length}/{MAX_NAME_LENGTH}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => { setName(currentName); setIsEditingName(false); }}
                    disabled={isUpdatingName}
                    className="p-2"
                  >
                    <Ionicons name="close" size={24} color="#9ca3af" />
                  </Pressable>
                  <Pressable
                    onPress={handleSaveName}
                    disabled={isUpdatingName || !name.trim()}
                    className="p-2"
                  >
                    {isUpdatingName ? (
                      <ActivityIndicator size="small" color="#2ad1af" />
                    ) : (
                      <Ionicons
                        name="checkmark"
                        size={24}
                        color={name.trim() ? '#2ad1af' : '#9ca3af'}
                      />
                    )}
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setIsEditingName(true)}
                  className="flex-row items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3"
                >
                  <Text className="text-base text-gray-900 dark:text-white">
                    {name || t('common.noName')}
                  </Text>
                  <Ionicons name="create-outline" size={20} color="#2ad1af" />
                </Pressable>
              )}
            </View>

            {/* My Username Section */}
            <View className="px-4 py-4">
              <Text className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-2">
                {t('rooms.myNameInRoom')}
              </Text>

              {isEditingUsername ? (
                <View className="flex-row items-center gap-2">
                  <View className="flex-1 relative">
                    <TextInput
                      value={username}
                      onChangeText={(text) => setUsername(text.slice(0, MAX_USERNAME_LENGTH))}
                      placeholder={t('rooms.yourNamePlaceholder')}
                      placeholderTextColor="#9ca3af"
                      maxLength={MAX_USERNAME_LENGTH}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={handleSaveUsername}
                      className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 text-base text-gray-900 dark:text-white pr-12"
                    />
                    <Text className="absolute right-3 top-3 text-xs text-gray-400">
                      {username.length}/{MAX_USERNAME_LENGTH}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => { setUsername(currentUsername); setIsEditingUsername(false); }}
                    disabled={isUpdatingUsername}
                    className="p-2"
                  >
                    <Ionicons name="close" size={24} color="#9ca3af" />
                  </Pressable>
                  <Pressable
                    onPress={handleSaveUsername}
                    disabled={isUpdatingUsername || !username.trim()}
                    className="p-2"
                  >
                    {isUpdatingUsername ? (
                      <ActivityIndicator size="small" color="#2ad1af" />
                    ) : (
                      <Ionicons
                        name="checkmark"
                        size={24}
                        color={username.trim() ? '#2ad1af' : '#9ca3af'}
                      />
                    )}
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setIsEditingUsername(true)}
                  className="flex-row items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3"
                >
                  <Text className="text-base text-gray-900 dark:text-white">
                    {username || t('common.noName')}
                  </Text>
                  <Ionicons name="create-outline" size={20} color="#2ad1af" />
                </Pressable>
              )}
            </View>

            {/* Invite Code Section */}
            {inviteCode ? (
              <View className="px-4 py-4">
                <Text className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-2">
                  {t('rooms.inviteCode')}
                </Text>
                <View className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-4 items-center">
                  <Text className="text-2xl font-bold tracking-widest" style={{ color: '#2ad1af' }}>
                    {inviteCode.toUpperCase()}
                  </Text>
                  <View className="flex-row gap-3 mt-4">
                    <Pressable
                      onPress={() => {
                        Clipboard.setStringAsync(`https://tillit.cc/roomcode/${inviteCode}`);
                        Alert.alert(t('common.copied'), t('common.linkCopied'));
                      }}
                      className="rounded-xl px-5 py-2.5 flex-row items-center"
                      style={{ backgroundColor: '#213649' }}
                    >
                      <Ionicons name="copy-outline" size={16} color="#fff" />
                      <Text className="text-white font-semibold text-sm ml-1.5">{t('common.copyLink')}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        Share.share({
                          message: t('rooms.shareInvite', { code: inviteCode }),
                        });
                      }}
                      className="rounded-xl px-5 py-2.5 flex-row items-center"
                      style={{ backgroundColor: '#2ad1af' }}
                    >
                      <Ionicons name="share-outline" size={16} color="#fff" />
                      <Text className="text-white font-semibold text-sm ml-1.5">{t('common.share')}</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}

            {/* Members Section */}
            <View className="px-4 py-4">
              <Text className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-2">
                {t('rooms.otherMembers', { count: members.filter(m => m.id_user !== currentUserId).length })}
              </Text>

              {isLoadingMembers ? (
                <View className="py-8 items-center">
                  <ActivityIndicator size="small" color="#2ad1af" />
                </View>
              ) : members.filter(m => m.id_user !== currentUserId).length === 0 ? (
                <Text className="text-gray-500 dark:text-gray-400 text-center py-4">
                  {t('rooms.noOtherMembers')}
                </Text>
              ) : (
                <View className="bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden">
                  {members
                    .filter(m => m.id_user !== currentUserId)
                    .map((member, index, arr) => (
                    <Pressable
                      key={member.id_user}
                      onLongPress={() => onReportUser(member.id_user, member.username)}
                      delayLongPress={500}
                      className={`flex-row items-center px-4 py-3 ${
                        index < arr.length - 1
                          ? 'border-b border-gray-200 dark:border-gray-700'
                          : ''
                      }`}
                    >
                      <View
                        className="w-10 h-10 rounded-full items-center justify-center mr-3"
                        style={{ backgroundColor: '#2ad1af' }}
                      >
                        <Text className="text-white font-semibold text-lg">
                          {(member.username || 'U').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <Text className="text-base text-gray-900 dark:text-white flex-1">
                        {member.username || `User ${member.id_user}`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {/* Delete / Leave Room */}
            <View className="px-4 py-4">
              <Pressable
                onPress={onDeleteRoom}
                className="rounded-xl py-3 items-center bg-red-50 dark:bg-red-900/20"
              >
                <Text className="text-red-600 dark:text-red-400 font-semibold text-base">
                  {administered === 1 && currentUserId !== roomOwnerId
                    ? t('rooms.leaveRoom')
                    : t('rooms.deleteRoom')}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}