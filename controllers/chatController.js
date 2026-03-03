const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const {
  setRoom,
  getRoom,
  hasRoom,
  deleteRoom,
  removeSearching,
  isSearching,
  atomicMatch,
  pushRandomMessage,
  getRandomMessages,
  deleteRandomMessages,
} = require('../utils/roomState');
const { enqueueMatchRetry, cancelMatchRetry } = require('../utils/matchQueue');
const logger = require('../utils/logger');
const { sendPushToUser, isUserActiveInRoom, templates } = require('../utils/pushNotifications');

const DISCONNECT_GRACE_PERIOD = 60000; // 60 seconds
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const CLIENT_MESSAGE_ID_RE = /^[a-zA-Z0-9_-]{8,120}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getOrCreateChat = async (userId, friendId) => {
  let chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
  if (!chat) {
    chat = await Chat.create({ participants: [userId, friendId], lastMessageAt: null });
  }
  return chat;
};

/**
 * performMatch — Finalises a random chat match between two users.
 *
 * Called from both the socket 'start_search' handler (immediate match) and
 * from the BullMQ worker (delayed retry match). Exported so matchQueue.js can
 * call it without creating a circular dependency.
 *
 * Uses io.in(userId).socketsJoin(roomId) which works across ALL instances
 * thanks to the Socket.IO Redis adapter.
 */
const performMatch = async (userId, candidateId, io) => {
  try {
    // Verify both users still have active connections on any server instance
    const [userSockets, candidateSockets] = await Promise.all([
      io.in(userId).fetchSockets(),
      io.in(candidateId).fetchSockets(),
    ]);

    if (userSockets.length === 0 && candidateSockets.length === 0) {
      // Both gone — nothing to do
      return;
    }
    if (userSockets.length === 0) {
      // userId disconnected — put candidate back in searching
      await atomicMatch(candidateId); // this re-adds candidateId if no one is waiting
      return;
    }
    if (candidateSockets.length === 0) {
      // Candidate disconnected — put userId back in searching and retry
      await atomicMatch(userId); // re-adds userId
      await enqueueMatchRetry(userId);
      return;
    }

    // Create room in Redis
    const roomId = [userId, candidateId].sort().join('-');
    await Promise.all([
      setRoom(userId, { roomId, type: 'random', partnerId: candidateId }),
      setRoom(candidateId, { roomId, type: 'random', partnerId: userId }),
      deleteRandomMessages(roomId), // fresh start
    ]);

    // Join both users' sockets to the room — works across instances via Redis adapter
    await Promise.all([
      io.in(userId).socketsJoin(roomId),
      io.in(candidateId).socketsJoin(roomId),
    ]);

    // Fetch user info — two targeted queries, NOT a loop over candidates
    const [user, candidate] = await Promise.all([
      User.findById(userId).select('user_name').lean(),
      User.findById(candidateId).select('user_name').lean(),
    ]);

    const userName = user?.user_name || 'Anonymous';
    const candidateName = candidate?.user_name || 'Anonymous';

    io.to(userId).emit('match_found', { partnerId: candidateId, partnerName: candidateName });
    io.to(candidateId).emit('match_found', { partnerId: userId, partnerName: userName });
    io.to(roomId).emit('chat_ready');

    logger.info('Match created', { userId, candidateId, roomId });

    Promise.all([
      sendPushToUser(userId, templates.randomMatchFound(candidateName, candidateId), User),
      sendPushToUser(candidateId, templates.randomMatchFound(userName, userId), User),
    ]).catch((err) => logger.error('Push failed for randomMatch', { error: err.message }));
  } catch (err) {
    logger.error('Error in performMatch', { userId, candidateId, error: err.message });
  }
};

// ─── Socket.IO Connection Handler ─────────────────────────────────────────────

const handleSocketConnection = (socket, io) => {
  const userId = socket.userId; // set by auth middleware in server.js
  logger.info('Socket connected', { socketId: socket.id, userId });

  if (userId) {
    // Each user joins a room named after their userId — this is how we target
    // a specific user with io.to(userId).emit(...)
    socket.join(userId);

    // Rejoin active room after reconnect (state is in Redis, survives restarts)
    getRoom(userId).then((existingRoom) => {
      if (existingRoom) {
        socket.join(existingRoom.roomId);
        logger.info('User rejoined active room on reconnect', {
          userId,
          roomId: existingRoom.roomId,
        });
      }
    }).catch((err) => logger.error('Error rejoining room on reconnect', { userId, error: err.message }));
  }

  // ─── start_search ────────────────────────────────────────────────────────

  socket.on('start_search', async () => {
    try {
      const [alreadySearching, alreadyInRoom] = await Promise.all([
        isSearching(userId),
        hasRoom(userId),
      ]);

      if (alreadySearching || alreadyInRoom) {
        socket.emit('error', { message: 'Already in a search or chat.' });
        return;
      }

      const user = await User.findById(userId).select('user_name').lean();
      if (!user) {
        socket.emit('error', { message: 'User not found.' });
        return;
      }

      logger.info('User started searching', { userId });

      // Lua atomic match: either returns a candidateId (matched!)
      // or adds userId to the searching set and returns null (waiting)
      const candidateId = await atomicMatch(userId);

      if (candidateId) {
        await performMatch(userId, candidateId, io);
      } else {
        // No immediate match — enqueue a delayed BullMQ job to retry
        await enqueueMatchRetry(userId);
        logger.info('User added to match queue', { userId });
      }
    } catch (err) {
      logger.error('Error in start_search', { userId, error: err.message });
      // Roll back: atomicMatch may have already added the user to the searching set.
      // Clean up so they can retry without hitting "Already in a search or chat."
      await removeSearching(userId).catch(() => {});
      socket.emit('error', { message: 'Server error during search.' });
    }
  });

  // ─── stop_search ─────────────────────────────────────────────────────────

  socket.on('stop_search', async () => {
    try {
      await Promise.all([
        removeSearching(userId),
        cancelMatchRetry(userId),
      ]);
      logger.info('User stopped searching', { userId });
    } catch (err) {
      logger.error('Error in stop_search', { userId, error: err.message });
    }
  });

  // ─── start_friend_chat ───────────────────────────────────────────────────

  socket.on('start_friend_chat', async ({ friendId }) => {
    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      socket.emit('error', { message: 'Invalid friendId.' });
      return;
    }

    try {
      const [user, friend] = await Promise.all([
        User.findById(userId).select('user_name friends').lean(),
        User.findById(friendId).select('user_name').lean(),
      ]);

      if (!user || !friend) {
        socket.emit('error', { message: 'User or friend not found.' });
        return;
      }
      if (!user.friends.some((id) => id.toString() === friendId)) {
        socket.emit('error', { message: 'You are not friends with this user.' });
        return;
      }

      const roomId = [userId, friendId].sort().join('_');
      await Promise.all([
        setRoom(userId, { roomId, type: 'friend', partnerId: friendId }),
      ]);

      socket.join(roomId);
      // Also join all sockets for the friend (across instances via Redis adapter)
      io.in(friendId).socketsJoin(roomId);

      const chat = await getOrCreateChat(userId, friendId);
      const messages = await Message.find({ chatId: chat._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      io.to(userId).emit('friend_chat_started', { partnerId: friendId, partnerName: friend.user_name });
      io.to(friendId).emit('friend_chat_started', { partnerId: userId, partnerName: user.user_name });
      io.to(roomId).emit('chat_history', {
        messages: messages.reverse().map((m) => ({
          _id: m._id,
          senderId: m.senderId,
          text: m.text,
          timestamp: m.createdAt,
          seen: m.seen,
          clientMessageId: m.clientMessageId,
        })),
      });

      logger.info('Friend chat started', { userId, friendId, roomId });
    } catch (err) {
      logger.error('Error in start_friend_chat', { userId, error: err.message });
      socket.emit('error', { message: 'Server error starting friend chat.' });
    }
  });

  // ─── leave_friend_chat ───────────────────────────────────────────────────

  socket.on('leave_friend_chat', async ({ friendId }) => {
    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;

    try {
      const room = await getRoom(userId);
      if (room && room.type === 'friend' && room.partnerId === friendId) {
        // Evict BOTH users' sockets from the room so the recipient doesn't
        // stay subscribed and receive double receive_message events later.
        io.in(userId).socketsLeave(room.roomId);
        io.in(friendId).socketsLeave(room.roomId);
        await deleteRoom(userId);
        io.to(friendId).emit('partner_left', { userId });
        logger.info('User left friend chat', { userId, friendId });
      }
    } catch (err) {
      logger.error('Error in leave_friend_chat', { userId, error: err.message });
    }
  });

  // ─── leave_chat (random) ─────────────────────────────────────────────────

  socket.on('leave_chat', async ({ toUserId }) => {
    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;

    try {
      const room = await getRoom(userId);
      if (room && room.type === 'random' && room.partnerId === toUserId) {
        io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
        socket.leave(room.roomId);
        await Promise.all([
          deleteRoom(userId),
          deleteRoom(toUserId),
          deleteRandomMessages(room.roomId),
        ]);
        logger.info('User left random chat', { userId, toUserId, roomId: room.roomId });
      }
    } catch (err) {
      logger.error('Error in leave_chat', { userId, error: err.message });
    }
  });

  // ─── typing / stop_typing ────────────────────────────────────────────────

  socket.on('typing', async ({ toUserId }) => {
    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;
    const room = await getRoom(userId).catch(() => null);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId: userId });
    }
  });

  socket.on('stop_typing', async ({ toUserId }) => {
    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;
    const room = await getRoom(userId).catch(() => null);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_stop_typing', { fromUserId: userId });
    }
  });

  // ─── message_seen (socket notification only) ─────────────────────────────

  socket.on('message_seen', async ({ toUserId, timestamp }) => {
    if (!toUserId || !timestamp || !OBJECT_ID_RE.test(toUserId)) return;
    const room = await getRoom(userId).catch(() => null);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId: userId, timestamp });
    }
  });

  // ─── send_message (socket path — random chat or friend chat) ─────────────

  socket.on('send_message', async ({ toUserId, message, timestamp, clientMessageId }) => {
    if (!toUserId || !message || !OBJECT_ID_RE.test(toUserId)) {
      socket.emit('error', { message: 'Invalid message payload.' });
      return;
    }
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > 2000) {
      socket.emit('error', { message: 'Message must be 1–2000 characters.' });
      return;
    }

    try {
      const room = await getRoom(userId);
      if (!room || room.partnerId !== toUserId) {
        socket.emit('error', { message: 'Not in a valid chat room with this user.' });
        return;
      }

      const trimmed = message.trim();
      const ts = timestamp || Date.now();

      if (room.type === 'friend') {
        // Friend messages MUST be persisted to DB — use the HTTP sendMessage route.
        // This socket path only delivers real-time notification; the client should
        // always send friend messages via POST /api/chats/send.
        // Here we simply relay so offline-send via HTTP still shows in real-time.
        io.to(room.roomId).emit('receive_message', {
          message: trimmed,
          fromUserId: userId,
          timestamp: ts,
          clientMessageId: clientMessageId || null,
        });
      } else {
        // Random chat — store in Redis List (migrated to DB on friend-accept)
        const newMsg = { senderId: userId, text: trimmed, timestamp: new Date(ts), seen: false };
        await pushRandomMessage(room.roomId, newMsg);

        io.to(room.roomId).emit('receive_message', {
          message: trimmed,
          fromUserId: userId,
          timestamp: ts,
        });
      }
    } catch (err) {
      logger.error('Error in send_message socket handler', { userId, error: err.message });
      socket.emit('error', { message: 'Server error sending message.' });
    }
  });

  // ─── friend_request_sent (in-chat signal) ────────────────────────────────

  socket.on('friend_request_sent', async ({ toUserId, fromUsername }) => {
    if (!toUserId || !OBJECT_ID_RE.test(toUserId)) return;
    const room = await getRoom(userId).catch(() => null);
    if (room && room.type === 'random' && room.partnerId === toUserId) {
      io.to(room.roomId).emit('friend_request_status', {
        fromUserId: userId,
        toUserId,
        fromUsername,
        status: 'sent',
      });
      io.to(toUserId).emit('friend_request_received', { fromUserId: userId, fromUsername });
    }
  });

  // ─── friend_request_accepted (in-chat signal) ────────────────────────────

  socket.on('friend_request_accepted', async ({ friendId }) => {
    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;
    try {
      // Derive the random-chat room ID directly — the HTTP acceptFriendRequest endpoint
      // already cleared Redis state, so getRoom(userId) would return null and the old
      // room-gated check would silently drop this event, leaving user A stuck in the chat screen.
      const randomRoomId = [userId, friendId].sort().join('-');

      io.to(randomRoomId).emit('friend_request_accepted', { userId, friendId });
      io.to(randomRoomId).emit('partner_disconnected', { disconnectedUserId: userId });
      io.to(randomRoomId).emit('partner_disconnected', { disconnectedUserId: friendId });
      socket.leave(randomRoomId);
      io.in(friendId).socketsLeave(randomRoomId);

      // Belt-and-suspenders cleanup — no-op if HTTP already handled it
      await Promise.all([
        deleteRoom(userId),
        deleteRoom(friendId),
        deleteRandomMessages(randomRoomId),
      ]).catch(() => {});
    } catch (err) {
      logger.error('Error in friend_request_accepted socket event', { userId, error: err.message });
    }
  });

  // ─── friend_request_rejected (in-chat signal) ────────────────────────────

  socket.on('friend_request_rejected', async ({ friendId }) => {
    if (!friendId || !OBJECT_ID_RE.test(friendId)) return;
    const room = await getRoom(userId).catch(() => null);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      io.to(room.roomId).emit('friend_request_status', {
        fromUserId: friendId,
        toUserId: userId,
        status: 'rejected',
      });
    }
  });

  // ─── disconnect ───────────────────────────────────────────────────────────

  socket.on('disconnect', async (reason) => {
    if (!userId) return;

    await Promise.all([
      removeSearching(userId),
      cancelMatchRetry(userId),
    ]).catch(() => {});

    logger.info('Socket disconnected', { userId, reason });

    const room = await getRoom(userId).catch(() => null);
    if (!room) return;

    // Grace period: give 60s for reconnection before cleaning up the room.
    // The room state lives in Redis so it persists across instances.
    setTimeout(async () => {
      try {
        const stillInRoom = await getRoom(userId);
        if (!stillInRoom) return; // already cleaned up (leave_chat, etc.)

        // Check across ALL instances whether this user has any active socket
        const activeSockets = await io.in(userId).fetchSockets();
        if (activeSockets.length === 0) {
          io.to(stillInRoom.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
          await Promise.all([
            deleteRoom(userId),
            deleteRoom(stillInRoom.partnerId),
            deleteRandomMessages(stillInRoom.roomId),
          ]);
          logger.info('User removed after grace period', {
            userId,
            roomId: stillInRoom.roomId,
          });
        }
      } catch (err) {
        logger.error('Error in disconnect grace period', { userId, error: err.message });
      }
    }, DISCONNECT_GRACE_PERIOD);
  });
};

// ─── HTTP Controllers ─────────────────────────────────────────────────────────

/**
 * POST /api/chats/send
 * Sends and persists a friend chat message.
 */
const sendMessage = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, message, clientMessageId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ message: 'Message cannot be empty.' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ message: 'Message must not exceed 2000 characters.' });
    }
    if (clientMessageId && (typeof clientMessageId !== 'string' || !CLIENT_MESSAGE_ID_RE.test(clientMessageId))) {
      return res.status(400).json({ message: 'Invalid clientMessageId format.' });
    }

    const user = await User.findById(userId).select('user_name friends').lean();
    if (!user || !user.friends.some((id) => id.toString() === friendId)) {
      return res.status(403).json({ message: 'You are not friends with this user.' });
    }

    const chat = await getOrCreateChat(userId, friendId);

    // Idempotency: return existing message if already processed
    if (clientMessageId) {
      const existing = await Message.findOne({ chatId: chat._id, senderId: userId, clientMessageId });
      if (existing) {
        return res.status(200).json({
          message: 'Message already processed.',
          messageId: existing._id,
          timestamp: existing.createdAt.getTime(),
          deduped: true,
        });
      }
    }

    const trimmed = message.trim();
    const newMessage = await Message.create({
      chatId: chat._id,
      senderId: userId,
      text: trimmed,
      seen: false,
      clientMessageId: clientMessageId || null,
    });

    chat.lastMessageAt = newMessage.createdAt;
    await chat.save();

    const roomId = [userId, friendId].sort().join('_');
    const msgPayload = {
      _id: newMessage._id,
      message: trimmed,
      fromUserId: userId,
      timestamp: newMessage.createdAt.getTime(),
      clientMessageId: newMessage.clientMessageId,
    };
    // Emit to the chat room for users who have the chat screen open.
    req.io.to(roomId).emit('receive_message', msgPayload);
    // Emit a lightweight notification to the recipient's personal room for unread badge
    // tracking. Using a separate event avoids double-counting: if the recipient's socket
    // is in both the chat room and their personal room (e.g. the sender called
    // start_friend_chat), receive_message would fire twice via the global listener.
    req.io.to(friendId).emit('friend_message_notification', { fromUserId: userId });

    // Only push if the recipient is not actively viewing the chat
    const recipientActive = await isUserActiveInRoom(req.io, friendId, roomId);
    if (!recipientActive) {
      sendPushToUser(
        friendId,
        templates.newMessage(user.user_name, trimmed, userId),
        User
      ).catch((err) => logger.error('Push failed for sendMessage', { error: err.message }));
    }

    return res.status(200).json({
      message: 'Message sent.',
      messageId: newMessage._id,
      timestamp: newMessage.createdAt.getTime(),
      deduped: false,
    });
  } catch (err) {
    logger.error('Error in sendMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * POST /api/chats/send-random
 * Validates the caller is in an active random room (used for REST fallback checks).
 */
const sendRandomMessage = async (req, res) => {
  try {
    const userId = req.userId;
    const { partnerId } = req.body;

    if (!partnerId || !OBJECT_ID_RE.test(partnerId)) {
      return res.status(400).json({ message: 'Invalid partnerId.' });
    }

    const room = await getRoom(userId);
    if (!room || room.type !== 'random' || room.partnerId !== partnerId) {
      return res.status(403).json({ message: 'Not in a random chat with this user.' });
    }

    return res.status(200).json({ message: 'Room active.' });
  } catch (err) {
    logger.error('Error in sendRandomMessage', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * GET /api/chats/:friendId
 * Returns paginated chat history for a friend conversation.
 */
const getChatHistory = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    if (!friendId || !OBJECT_ID_RE.test(friendId)) {
      return res.status(400).json({ message: 'Invalid friendId.' });
    }

    const user = await User.findById(userId).select('friends').lean();
    if (!user || !user.friends.some((id) => id.toString() === friendId)) {
      return res.status(403).json({ message: 'You are not friends with this user.' });
    }

    const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      return res.status(200).json({ messages: [], total: 0, page, limit });
    }

    const total = await Message.countDocuments({ chatId: chat._id });
    const skip = Math.max(0, total - page * limit);
    const docs = await Message.find({ chatId: chat._id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const messages = docs.map((m) => ({
      _id: m._id,
      senderId: m.senderId,
      text: m.text,
      timestamp: m.createdAt,
      seen: m.seen,
      seenAt: m.seenAt,
      clientMessageId: m.clientMessageId,
    }));

    return res.status(200).json({ messages, total, page, limit });
  } catch (err) {
    logger.error('Error in getChatHistory', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * POST /api/chats/seen
 * Marks a message as seen and broadcasts the event to the room.
 */
const markMessageSeen = async (req, res) => {
  try {
    const userId = req.userId;
    const { friendId, timestamp, messageId } = req.body;

    if (!friendId || !OBJECT_ID_RE.test(friendId) || (!timestamp && !messageId)) {
      return res.status(400).json({
        message: 'Invalid payload. Provide friendId and messageId or timestamp.',
      });
    }

    const chat = await Chat.findOne({ participants: { $all: [userId, friendId] } });
    if (!chat) {
      return res.status(404).json({ message: 'Chat not found.' });
    }

    // Mark ALL unseen messages from the friend up to (and including) the given timestamp.
    // This ensures every message in the conversation is marked, not just the one with an exact match.
    const seenAt = new Date();
    const cutoff = new Date(Number(timestamp));

    const result = await Message.updateMany(
      { chatId: chat._id, senderId: friendId, seen: false, createdAt: { $lte: cutoff } },
      { seen: true, seenAt }
    );

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('message_seen', {
      fromUserId: userId,
      timestamp: Number(timestamp),
    });

    return res.status(200).json({ message: 'Messages marked as seen.', count: result.modifiedCount });
  } catch (err) {
    logger.error('Error in markMessageSeen', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  handleSocketConnection,
  performMatch,
  sendMessage,
  sendRandomMessage,
  getChatHistory,
  markMessageSeen,
};
