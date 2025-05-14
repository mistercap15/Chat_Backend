const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');

const searchingUsers = new Set();
const DISCONNECT_GRACE_PERIOD = 60000; // 1 minute

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] ChatController: ${message}`, data || '');
};

const handleSocketConnection = (socket, io) => {
  log('User connected', { socketId: socket.id });

  socket.on('set_username', async ({ userId, username }) => {
    log('Received set_username', { userId, username });
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Validation failed: Invalid userId', { userId });
      socket.emit('error', { message: 'Invalid userId' });
      return;
    }
    socket.userId = userId;
    socket.username = username || 'Anonymous';
    socket.join(userId);
    log('Username set', { userId, username: socket.username });

    const room = activeRooms.get(userId);
    if (room) {
      socket.join(room.roomId);
      log('User rejoined room', { userId, roomId: room.roomId });
    }
  });

  socket.on('start_search', async ({ userId, username }) => {
    log('Received start_search', { userId, username });
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Validation failed: Invalid userId', { userId });
      socket.emit('error', { message: 'Invalid userId' });
      return;
    }

    if (searchingUsers.has(userId) || activeRooms.has(userId)) {
      log('User already searching or in chat', { userId });
      socket.emit('error', { message: 'Already in a search or chat' });
      return;
    }

    try {
      const user = await User.findById(userId).select('user_name friends');
      if (!user) {
        log('User not found', { userId });
        socket.emit('error', { message: 'User not found' });
        return;
      }

      socket.userId = userId;
      socket.username = user.user_name || username || 'Anonymous';
      searchingUsers.add(userId);
      log('User added to searching', { userId, totalSearching: searchingUsers.size });

      await tryMatchUser(userId, socket, io);
    } catch (error) {
      log('Error in start_search', { userId, error: error.message });
      searchingUsers.delete(userId);
      socket.emit('error', { message: 'Server error during search' });
    }
  });

  socket.on('stop_search', ({ userId }) => {
    log('Received stop_search', { userId });
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      log('Validation failed: Invalid userId', { userId });
      return;
    }
    searchingUsers.delete(userId);
    log('User removed from searching', { userId });
  });

  socket.on('start_friend_chat', async ({ userId, friendId, username }) => {
    log('Received start_friend_chat', { userId, friendId, username });
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      socket.emit('error', { message: 'Invalid userId or friendId' });
      return;
    }

    try {
      const user = await User.findById(userId).select('user_name friends');
      const friend = await User.findById(friendId).select('user_name');
      if (!friend || !user || !user.friends.includes(friendId)) {
        log('User or friend not found or not friends', { userId, friendId });
        socket.emit('error', { message: 'User or friend not found or not friends' });
        return;
      }

      const roomId = [userId, friendId].sort().join('_');
      activeRooms.set(userId, { roomId, type: 'friend', partnerId: friendId });
      socket.join(roomId);
      io.to(friendId).socketsJoin(roomId);
      log('Friend chat started', { userId, friendId, roomId });

      const chat = await Chat.findOne({
        participants: { $all: [userId, friendId] },
      });

      io.to(userId).emit('friend_chat_started', {
        partnerId: friendId,
        partnerName: friend.user_name,
      });
      io.to(friendId).emit('friend_chat_started', {
        partnerId: userId,
        partnerName: user.user_name,
      });
      log('Emitted friend_chat_started', { userId, friendId });

      io.to(roomId).emit('chat_history', { messages: chat ? chat.messages : [] });
      log('Emitted chat_history', { roomId, messageCount: chat ? chat.messages.length : 0 });
    } catch (error) {
      log('Error in start_friend_chat', { userId, friendId, error: error.message });
      socket.emit('error', { message: 'Server error starting friend chat' });
    }
  });

  socket.on('leave_friend_chat', ({ userId, friendId }) => {
    log('Received leave_friend_chat', { userId, friendId });
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return;
    }
    const room = activeRooms.get(userId);
    if (room && room.type === 'friend' && room.partnerId === friendId) {
      socket.leave(room.roomId);
      activeRooms.delete(userId);
      io.to(friendId).emit('partner_disconnected', { disconnectedUserId: userId });
      log('User left friend chat', { userId, friendId, roomId: room.roomId });
    }
  });

  socket.on('typing', ({ toUserId, fromUserId }) => {
    log('Received typing', { toUserId, fromUserId });
    if (!fromUserId || !toUserId || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      log('Validation failed: Invalid user IDs', { fromUserId, toUserId });
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId });
      log('Emitted partner_typing', { roomId: room.roomId, fromUserId });
    }
  });

  socket.on('message_seen', ({ toUserId, fromUserId, timestamp }) => {
    log('Received message_seen', { toUserId, fromUserId, timestamp });
    if (!fromUserId || !toUserId || !timestamp || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      log('Validation failed: Invalid data', { fromUserId, toUserId, timestamp });
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId, timestamp });
      log('Emitted message_seen', { roomId: room.roomId, fromUserId, timestamp });
    }
  });

  socket.on('leave_chat', ({ toUserId }) => {
    log('Received leave_chat', { userId: socket.userId, toUserId });
    if (!socket.userId || !toUserId || !/^[0-9a-fA-F]{24}$/.test(socket.userId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      log('Validation failed: Invalid user IDs', { userId: socket.userId, toUserId });
      return;
    }
    const room = activeRooms.get(socket.userId);
    if (room && room.type === 'random') {
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: socket.userId });
      socket.leave(room.roomId);
      activeRooms.delete(socket.userId);
      activeRooms.delete(toUserId);
      randomChatMessages.delete(room.roomId);
      log('User left random chat', { userId: socket.userId, toUserId, roomId: room.roomId });
    }
  });

  socket.on('send_message', ({ toUserId, message, fromUserId, timestamp }) => {
    log('Received send_message', { toUserId, fromUserId, timestamp });
    if (!fromUserId || !toUserId || !message || !timestamp || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      log('Validation failed: Invalid message data', { fromUserId, toUserId, message, timestamp });
      socket.emit('error', { message: 'Invalid message data' });
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      io.to(toUserId).emit('receive_message', { message, fromUserId, timestamp }); // Emit only to recipient
      if (room.type === 'random') {
        const messages = randomChatMessages.get(room.roomId) || [];
        // Deduplication: Check if message with same text and sender exists within 1 second
        const dedupeWindow = 1000;
        const recentMessages = messages.filter((msg) => Math.abs(new Date(msg.timestamp).getTime() - timestamp) < dedupeWindow);
        if (!recentMessages.some((msg) => msg.text === message && msg.senderId === fromUserId)) {
          messages.push({ senderId: fromUserId, text: message, timestamp: new Date(timestamp), seen: false });
          randomChatMessages.set(room.roomId, messages);
          log('Stored random chat message', { roomId: room.roomId, messageCount: messages.length });
        } else {
          log('Ignored duplicate random chat message', { roomId: room.roomId, message, timestamp });
        }
      }
      log('Emitted receive_message to recipient', { toUserId, fromUserId, timestamp });
    } else {
      log('Room validation failed', { fromUserId, toUserId, room });
      socket.emit('error', { message: 'Not in a valid chat room' });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      log('User disconnected', { userId: socket.userId });
      searchingUsers.delete(socket.userId);
      const room = activeRooms.get(socket.userId);
      if (room) {
        setTimeout(() => {
          let userSocket = null;
          io.sockets.sockets.forEach((s) => {
            if (s.userId === socket.userId && s.connected) {
              userSocket = s;
            }
          });
          if (!userSocket) {
            io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: socket.userId });
            socket.leave(room.roomId);
            activeRooms.delete(socket.userId);
            if (room.type === 'random') {
              activeRooms.delete(room.partnerId);
              randomChatMessages.delete(room.roomId);
            }
            log('Emitted partner_disconnected after grace period', { userId: socket.userId, roomId: room.roomId });
          } else {
            log('User reconnected within grace period', { userId: socket.userId });
          }
        }, DISCONNECT_GRACE_PERIOD);
      }
    }
  });
};

async function tryMatchUser(userId, socket, io) {
  log('Trying to match user', { userId });
  try {
    const user = await User.findById(userId).select('user_name friends');
    if (!user || !searchingUsers.has(userId)) {
      log('User not found or not searching', { userId });
      searchingUsers.delete(userId);
      return;
    }

    const otherUsers = [...searchingUsers].filter((id) => id !== userId);
    if (otherUsers.length === 0) {
      log('No other users to match', { userId });
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    const friends = user.friends.map((id) => id.toString());
    let matchedUser = null;
    for (const otherUserId of otherUsers) {
      if (!activeRooms.has(otherUserId) && !friends.includes(otherUserId)) {
        const otherUser = await User.findById(otherUserId).select('user_name friends');
        if (otherUser && !otherUser.friends.includes(userId)) {
          matchedUser = otherUserId;
          break;
        }
      }
    }

    if (!matchedUser) {
      log('No match found, retrying', { userId });
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    searchingUsers.delete(userId);
    searchingUsers.delete(matchedUser);
    log('Users removed from searching', { userId, matchedUser });

    const matchedUserData = await User.findById(matchedUser).select('user_name');
    const roomId = [userId, matchedUser].sort().join('-');
    activeRooms.set(userId, { roomId, type: 'random', partnerId: matchedUser });
    activeRooms.set(matchedUser, { roomId, type: 'random', partnerId: userId });
    randomChatMessages.set(roomId, []);
    log('Room created', { roomId, userId, matchedUser });

    socket.join(roomId);
    let matchedUserSocket = null;
    for (const [_, s] of await io.sockets.sockets) {
      if (s.userId === matchedUser) {
        matchedUserSocket = s;
        break;
      }
    }

    if (!matchedUserSocket) {
      log('Matched user not connected', { matchedUser });
      searchingUsers.add(userId);
      activeRooms.delete(userId);
      activeRooms.delete(matchedUser);
      randomChatMessages.delete(roomId);
      socket.emit('error', { message: 'Matched user not connected' });
      return;
    }

    matchedUserSocket.join(roomId);
    socket.emit('match_found', {
      partnerId: matchedUser,
      partnerName: matchedUserData?.user_name || 'Anonymous',
    });
    matchedUserSocket.emit('match_found', {
      partnerId: userId,
      partnerName: user.user_name || 'Anonymous',
    });
    log('Match completed', { userId, matchedUser, roomId });
  } catch (error) {
    log('Error matching user', { userId, error: error.message });
    searchingUsers.delete(userId);
    socket.emit('error', { message: 'Server error during matching' });
  }
}

const sendMessage = async (req, res) => {
  log('Received sendMessage request', { body: req.body });
  try {
    const { userId, friendId, message } = req.body;

    if (!userId || !friendId || !message || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId, friendId, or message', { userId, friendId, message });
      return res.status(400).json({ message: 'Invalid userId, friendId, or message.' });
    }

    const user = await User.findById(userId).select('friends');
    if (!user || !user.friends.includes(friendId)) {
      log('Users are not friends', { userId, friendId });
      return res.status(403).json({ message: 'Users are not friends.' });
    }

    let chat = await Chat.findOne({
      participants: { $all: [userId, friendId] },
    });

    if (!chat) {
      chat = new Chat({
        participants: [userId, friendId],
        messages: [],
      });
    }

    const timestamp = new Date();
    const messageData = {
      senderId: userId,
      text: message,
      timestamp,
      seen: false,
    };

    chat.messages.push(messageData);
    await chat.save();
    log('Message saved', { userId, friendId, timestamp });

    if (!req.io) {
      log('Socket.IO instance missing', { userId, friendId });
      return res.status(500).json({ message: 'Socket.IO instance not available.' });
    }

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('receive_message', {
      message,
      fromUserId: userId,
      timestamp: timestamp.getTime(),
    });
    log('Emitted receive_message', { roomId, fromUserId: userId, timestamp });

    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    log('Error in sendMessage', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

const sendRandomMessage = async (req, res) => {
  log('Received sendRandomMessage request', { body: req.body });
  try {
    const { userId, partnerId, message } = req.body;

    if (!userId || !partnerId || !message || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(partnerId)) {
      log('Validation failed: Invalid userId, partnerId, or message', { userId, partnerId, message });
      return res.status(400).json({ message: 'Invalid userId, partnerId, or message.' });
    }

    const room = activeRooms.get(userId);
    if (!room || room.type !== 'random' || room.partnerId !== partnerId) {
      log('Not in a random chat with this user', { userId, partnerId });
      return res.status(403).json({ message: 'Not in a random chat with this user.' });
    }

    // Note: Message emission is handled by the socket 'send_message' event, so no emission here
    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    log('Error in sendRandomMessage', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

const getChatHistory = async (req, res) => {
  log('Received getChatHistory request', { params: req.params });
  try {
    const { userId, friendId } = req.params;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId or friendId', { userId, friendId });
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const chat = await Chat.findOne({
      participants: { $all: [userId, friendId] },
    });

    log('Chat history retrieved', { userId, friendId, messageCount: chat ? chat.messages.length : 0 });
    res.status(200).json({ messages: chat ? chat.messages : [] });
  } catch (err) {
    log('Error in getChatHistory', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

const markMessageSeen = async (req, res) => {
  log('Received markMessageSeen request', { body: req.body });
  try {
    const { userId, friendId, timestamp } = req.body;

    if (!userId || !friendId || !timestamp || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      log('Validation failed: Invalid userId, friendId, or timestamp', { userId, friendId, timestamp });
      return res.status(400).json({ message: 'Invalid userId, friendId, or timestamp.' });
    }

    const chat = await Chat.findOne({
      participants: { $all: [userId, friendId] },
    });

    if (!chat) {
      log('Chat not found', { userId, friendId });
      return res.status(404).json({ message: 'Chat not found.' });
    }

    const message = chat.messages.find(
      (msg) => msg.timestamp.getTime() === timestamp && msg.senderId.toString() === friendId
    );

    if (!message) {
      log('Message not found', { userId, friendId, timestamp });
      return res.status(404).json({ message: 'Message not found.' });
    }

    message.seen = true;
    await chat.save();
    log('Message marked as seen', { userId, friendId, timestamp });

    if (!req.io) {
      log('Socket.IO instance missing', { userId, friendId });
      return res.status(500).json({ message: 'Socket.IO instance not available.' });
    }

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('message_seen', { fromUserId: userId, timestamp });
    log('Emitted message_seen', { roomId, fromUserId: userId, timestamp });

    res.status(200).json({ message: 'Message marked as seen.' });
  } catch (err) {
    log('Error in markMessageSeen', { error: err.message });
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  handleSocketConnection,
  sendMessage,
  sendRandomMessage,
  getChatHistory,
  markMessageSeen,
};