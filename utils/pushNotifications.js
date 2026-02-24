const { Expo } = require('expo-server-sdk');
const logger = require('./logger');

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  useFcmV1: true, // Use FCM v1 API (required after June 2024)
});

// ─── Core Send ────────────────────────────────────────────────────────────────

/**
 * Sends a push notification to a single Expo push token.
 * Returns 'invalid_token' if the token is not a valid Expo token.
 * Returns 'device_not_registered' if the device has uninstalled the app.
 */
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

/**
 * Looks up a user's stored Expo push token and sends them a notification.
 * Automatically nulls out the token in the DB if the device is unregistered.
 *
 * @param {string} userId - Mongoose ObjectId string
 * @param {object} notification - { title, body, data, channelId, badge }
 * @param {Model}  UserModel   - The Mongoose User model (passed to avoid circular deps)
 */
const sendPushToUser = async (userId, notification, UserModel) => {
  try {
    const user = await UserModel.findById(userId).select('expoPushToken');
    if (!user || !user.expoPushToken) return;

    const result = await sendPushNotification(user.expoPushToken, notification);

    // Clear stale token from DB so we don't keep hitting a dead endpoint
    if (result === 'device_not_registered' || result === 'invalid_token') {
      await UserModel.findByIdAndUpdate(userId, { expoPushToken: null });
      logger.info('Cleared stale push token', { userId });
    }
  } catch (err) {
    logger.error('sendPushToUser failed', { userId, error: err.message });
  }
};

/**
 * Sends notifications to multiple users in parallel.
 * @param {Array<{ userId: string, notification: object }>} targets
 * @param {Model} UserModel
 */
const sendPushToUsers = (targets, UserModel) =>
  Promise.all(targets.map(({ userId, notification }) => sendPushToUser(userId, notification, UserModel)));

// ─── Notification Templates ───────────────────────────────────────────────────

const templates = {
  /**
   * New friend chat message.
   * Only sent when the recipient is NOT actively in the friend chat room.
   */
  newMessage: (senderName, messageText, senderId) => ({
    title: senderName,
    body: messageText.length > 100 ? `${messageText.slice(0, 97)}…` : messageText,
    channelId: 'messages',
    data: {
      type: 'message',
      chatType: 'friend',
      senderId,
      senderName,
    },
  }),

  /** Someone sent this user a friend request. */
  friendRequest: (fromUsername, fromUserId) => ({
    title: 'New Friend Request',
    body: `${fromUsername} wants to be your friend`,
    channelId: 'social',
    data: {
      type: 'friend_request',
      fromUserId,
      fromUsername,
    },
  }),

  /** Someone accepted this user's friend request. */
  friendAccepted: (acceptorName, friendId) => ({
    title: 'Friend Request Accepted!',
    body: `${acceptorName} accepted your friend request`,
    channelId: 'social',
    data: {
      type: 'friend_accepted',
      friendId,
      friendName: acceptorName,
    },
  }),

  /** A random chat match was found. */
  randomMatchFound: (partnerName, partnerId) => ({
    title: 'Match Found!',
    body: `You have been matched with ${partnerName}`,
    channelId: 'matches',
    data: {
      type: 'random_match',
      partnerId,
      partnerName,
    },
  }),
};

// ─── Helper: Is User Actively In A Socket Room ───────────────────────────────

/**
 * Returns true if a user (identified by userId on socket) currently has
 * a socket joined to the given roomId. Used to skip push notifications
 * when the user is already viewing the relevant chat screen.
 */
const isUserActiveInRoom = (io, userId, roomId) => {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return false;

  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId === userId && socket.rooms.has(roomId)) {
      return true;
    }
  }
  return false;
};

module.exports = {
  sendPushToUser,
  sendPushToUsers,
  isUserActiveInRoom,
  templates,
};
