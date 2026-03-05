const { Expo } = require('expo-server-sdk');
const logger = require('./logger');

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  useFcmV1: true, // FCM v1 API (required after June 2024)
});

// ─── Core Send ────────────────────────────────────────────────────────────────

const sendPushNotification = async (token, { title, body, data = {}, channelId = 'default', badge }) => {
  if (!token || !Expo.isExpoPushToken(token)) {
    logger.debug('Skipping push: invalid Expo push token', { token });
    return 'invalid_token';
  }

  const message = {
    to: token,
    sound: 'default',
    title,
    body,
    data,
    channelId,
    ...(badge !== undefined && { badge }),
  };

  try {
    const [ticket] = await expo.sendPushNotificationsAsync([message]);

    if (ticket.status === 'error') {
      logger.warn('Push notification ticket error', {
        error: ticket.message,
        details: ticket.details,
      });
      if (ticket.details?.error === 'DeviceNotRegistered') {
        return 'device_not_registered';
      }
    }

    return ticket;
  } catch (err) {
    logger.error('Push notification send failed', { error: err.message });
    return null;
  }
};

// ─── Per-User Send (with automatic stale-token cleanup) ───────────────────────

const sendPushToUser = async (userId, notification, UserModel) => {
  try {
    const user = await UserModel.findById(userId).select('expoPushToken');
    if (!user || !user.expoPushToken) return;

    const result = await sendPushNotification(user.expoPushToken, notification);

    if (result === 'device_not_registered' || result === 'invalid_token') {
      await UserModel.findByIdAndUpdate(userId, { expoPushToken: null });
      logger.info('Cleared stale push token', { userId });
    }
  } catch (err) {
    logger.error('sendPushToUser failed', { userId, error: err.message });
  }
};

const sendPushToUsers = (targets, UserModel) =>
  Promise.all(targets.map(({ userId, notification }) => sendPushToUser(userId, notification, UserModel)));

// ─── Notification Templates ───────────────────────────────────────────────────

const templates = {
  newMessage: (senderName, messageText, senderId) => ({
    title: senderName,
    body: messageText.length > 100 ? `${messageText.slice(0, 97)}…` : messageText,
    channelId: 'messages',
    data: { type: 'message', chatType: 'friend', senderId, senderName },
  }),
  friendRequest: (fromUsername, fromUserId) => ({
    title: 'New Friend Request',
    body: `${fromUsername} wants to be your friend`,
    channelId: 'social',
    data: { type: 'friend_request', fromUserId, fromUsername },
  }),
  friendAccepted: (acceptorName, friendId) => ({
    title: 'Friend Request Accepted!',
    body: `${acceptorName} accepted your friend request`,
    channelId: 'social',
    data: { type: 'friend_accepted', friendId, friendName: acceptorName },
  }),
  randomMatchFound: (partnerName, partnerId) => ({
    title: 'Match Found!',
    body: `You have been matched with ${partnerName}`,
    channelId: 'matches',
    data: { type: 'random_match', partnerId, partnerName },
  }),
};

// ─── Is User Actively In A Socket Room ───────────────────────────────────────

/**
 * Returns true if the given user has at least one socket joined to roomId,
 * across ALL server instances (via the Socket.IO Redis adapter's fetchSockets).
 *
 * Used to suppress push notifications when the user is already looking at the chat.
 */
const isUserActiveInRoom = async (io, userId, roomId) => {
  try {
    // fetchSockets() fetches from ALL instances when using @socket.io/redis-adapter
    const sockets = await io.in(roomId).fetchSockets();
    // RemoteSocket objects expose socket.data (set from socket.data.userId in server.js)
    return sockets.some((s) => s.data?.userId === userId);
  } catch {
    return false; // fail-safe: assume user is not active, so push is sent
  }
};

module.exports = {
  sendPushToUser,
  sendPushToUsers,
  isUserActiveInRoom,
  templates,
};
