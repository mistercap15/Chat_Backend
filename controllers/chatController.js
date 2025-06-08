// server/controllers/ChatController.js
const User = require('../models/User');
const Chat = require('../models/Chat');
const { activeRooms, randomChatMessages } = require('../utils/activeRooms');

const searchingUsers = new Set();
const DISCONNECT_GRACE_PERIOD = 60000;

const log = (message, data) => {
  console.log(`[${new Date().toISOString()}] ChatController: ${message}`, data || '');
};

const handleSocketConnection = (socket, io) => {
  log('User connected', { socketId: socket.id });

  socket.on('set_username', async ({ userId, username }) => {
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
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
      log('User rejoined room', { userId, roomId: room.roomId, partnerId: room.partnerId });
    }
  });

  socket.on('start_search', async ({ userId, username }) => {
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      socket.emit('error', { message: 'Invalid userId' });
      return;
    }

    if (searchingUsers.has(userId) || activeRooms.has(userId)) {
      socket.emit('error', { message: 'Already in a search or chat' });
      return;
    }

    try {
      const user = await User.findById(userId).select('user_name friends');
      if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      socket.userId = userId;
      socket.username = user.user_name || username || 'Anonymous';
      searchingUsers.add(userId);
      await tryMatchUser(userId, socket, io);
    } catch (error) {
      searchingUsers.delete(userId);
      socket.emit('error', { message: 'Server error during search' });
    }
  });

  socket.on('stop_search', ({ userId }) => {
    if (!userId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      return;
    }
    searchingUsers.delete(userId);
    log('User removed from searching', { userId });
  });

  socket.on('start_friend_chat', async ({ userId, friendId, username }) => {
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      socket.emit('error', { message: 'Invalid userId or friendId' });
      return;
    }

    try {
      const user = await User.findById(userId).select('user_name friends');
      const friend = await User.findById(friendId).select('user_name');
      if (!friend || !user || !user.friends.includes(friendId)) {
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
      io.to(roomId).emit('chat_history', { messages: chat ? chat.messages : [] });
    } catch (error) {
      socket.emit('error', { message: 'Server error starting friend chat' });
    }
  });

  socket.on('leave_friend_chat', ({ userId, friendId }) => {
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
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

  socket.on('leave_chat', ({ toUserId }) => {
    if (!socket.userId || !toUserId || !/^[0-9a-fA-F]{24}$/.test(socket.userId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      return;
    }
    const room = activeRooms.get(socket.userId);
    if (room && room.type === 'random' && room.partnerId === toUserId) {
      log('Processing leave_chat', { userId: socket.userId, toUserId, roomId: room.roomId });
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: socket.userId });
      socket.leave(room.roomId);
      activeRooms.delete(socket.userId);
      activeRooms.delete(toUserId);
      randomChatMessages.delete(room.roomId);
      log('User left random chat', { userId: socket.userId, toUserId, roomId: room.roomId });
    } else {
      log('Invalid leave_chat attempt', { userId: socket.userId, toUserId, room });
    }
  });

  socket.on('join_room', ({ roomId, userId }) => {
    if (!userId || !roomId || !/^[0-9a-fA-F]{24}$/.test(userId)) {
      return;
    }
    socket.join(roomId);
    log('User joined room', { userId, roomId });
  });

  socket.on('typing', ({ toUserId, fromUserId }) => {
    if (!fromUserId || !toUserId || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('partner_typing', { fromUserId });
      log('Typing event relayed', { fromUserId, toUserId, roomId: room.roomId });
    }
  });

  socket.on('message_seen', ({ toUserId, fromUserId, timestamp }) => {
    if (!fromUserId || !toUserId || !timestamp || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      io.to(room.roomId).emit('message_seen', { fromUserId, timestamp });
      log('Message seen event relayed', { fromUserId, toUserId, timestamp, roomId: room.roomId });
    }
  });

  socket.on('send_message', ({ toUserId, message, fromUserId, timestamp }) => {
    if (!fromUserId || !toUserId || !message || !timestamp || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      socket.emit('error', { message: 'Invalid message data' });
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.partnerId === toUserId) {
      log('Relaying message', { fromUserId, toUserId, message, timestamp, roomId: room.roomId });
      io.to(room.roomId).emit('receive_message', { message, fromUserId, timestamp });
      if (room.type === 'random') {
        const messages = randomChatMessages.get(room.roomId) || [];
        const dedupeWindow = 1000;
        const recentMessages = messages.filter((msg) => Math.abs(new Date(msg.timestamp).getTime() - timestamp) < dedupeWindow);
        if (!recentMessages.some((msg) => msg.text === message && msg.senderId === fromUserId)) {
          messages.push({ senderId: fromUserId, text: message, timestamp: new Date(timestamp), seen: false });
          randomChatMessages.set(room.roomId, messages);
        }
      }
    } else {
      log('Message not relayed', { fromUserId, toUserId, reason: 'Invalid room or partner', room });
      socket.emit('error', { message: 'Not in a valid chat room' });
    }
  });

  socket.on('friend_request_sent', ({ toUserId, fromUserId, fromUsername }) => {
    if (!fromUserId || !toUserId || !/^[0-9a-fA-F]{24}$/.test(fromUserId) || !/^[0-9a-fA-F]{24}$/.test(toUserId)) {
      return;
    }
    const room = activeRooms.get(fromUserId);
    if (room && room.type === 'random' && room.partnerId === toUserId) {
      io.to(room.roomId).emit('friend_request_status', { fromUserId, toUserId, fromUsername, status: 'sent' });
      io.to(toUserId).emit('friend_request_received', { fromUserId, fromUsername });
      log('Friend request sent', { fromUserId, toUserId, roomId: room.roomId });
    }
  });

  socket.on('friend_request_accepted', async ({ userId, friendId }) => {
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      return;
    }
    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      io.to(room.roomId).emit('friend_request_accepted', { userId, friendId });
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: userId });
      io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: friendId });
      socket.leave(room.roomId);
      io.to(friendId).socketsLeave(room.roomId);
      activeRooms.delete(userId);
      activeRooms.delete(friendId);
      randomChatMessages.delete(room.roomId);
      log('Random chat terminated due to friend request acceptance', { userId, friendId, roomId: room.roomId });
    }
  });

  socket.on('friend_request_rejected', ({ userId, friendId }) => {
    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      return;
    }
    const room = activeRooms.get(userId);
    if (room && room.type === 'random' && room.partnerId === friendId) {
      io.to(room.roomId).emit('friend_request_status', { fromUserId: friendId, toUserId: userId, status: 'rejected' });
      log('Friend request rejected', { userId, friendId, roomId: room.roomId });
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      searchingUsers.delete(socket.userId);
      const room = activeRooms.get(socket.userId);
      if (room) {
        const timeout = setTimeout(() => {
          let userSocket = null;
          io.sockets.sockets.forEach((s) => {
            if (s.userId === socket.userId && s.connected) {
              userSocket = s;
            }
          });
          if (!userSocket && activeRooms.get(socket.userId)) {
            io.to(room.roomId).emit('partner_disconnected', { disconnectedUserId: socket.userId });
            socket.leave(room.roomId);
            activeRooms.delete(socket.userId);
            activeRooms.delete(room.partnerId);
            randomChatMessages.delete(room.roomId);
            log('User confirmed disconnected', { userId: socket.userId, roomId: room.roomId });
          }
        }, DISCONNECT_GRACE_PERIOD);
        log('User disconnected, scheduling check', { userId: socket.userId, roomId: room.roomId });
      }
    }
  });
};

async function tryMatchUser(userId, socket, io) {
  try {
    const user = await User.findById(userId).select('user_name friends');
    if (!user || !searchingUsers.has(userId)) {
      searchingUsers.delete(userId);
      return;
    }

    const otherUsers = [...searchingUsers].filter((id) => id !== userId);
    if (otherUsers.length === 0) {
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
      setTimeout(() => tryMatchUser(userId, socket, io), 1000);
      return;
    }

    searchingUsers.delete(userId);
    searchingUsers.delete(matchedUser);

    const matchedUserData = await User.findById(matchedUser).select('user_name');
    const roomId = [userId, matchedUser].sort().join('-');
    activeRooms.set(userId, { roomId, type: 'random', partnerId: matchedUser });
    activeRooms.set(matchedUser, { roomId, type: 'random', partnerId: userId });
    randomChatMessages.set(roomId, []);

    socket.join(roomId);
    let matchedUserSocket = null;
    for (const [_, s] of io.sockets.sockets) {
      if (s.userId === matchedUser) {
        matchedUserSocket = s;
        break;
      }
    }

    if (!matchedUserSocket) {
      searchingUsers.add(userId);
      activeRooms.delete(userId);
      activeRooms.delete(matchedUser);
      randomChatMessages.delete(roomId);
      socket.emit('error', { message: 'Matched user not connected' });
      return;
    }

    matchedUserSocket.join(roomId);
    log('Match created', { userId, matchedUser, roomId });
    socket.emit('match_found', {
      partnerId: matchedUser,
      partnerName: matchedUserData?.user_name || 'Anonymous',
    });
    matchedUserSocket.emit('match_found', {
      partnerId: userId,
      partnerName: user.user_name || 'Anonymous',
    });
    io.to(roomId).emit('chat_ready');
  } catch (error) {
    searchingUsers.delete(userId);
    socket.emit('error', { message: 'Server error during matching' });
  }
}

const sendMessage = async (req, res) => {
  try {
    const { userId, friendId, message } = req.body;

    if (!userId || !friendId || !message || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      return res.status(400).json({ message: 'Invalid userId, friendId, or message.' });
    }

    const user = await User.findById(userId).select('friends');
    if (!user || !user.friends.includes(friendId)) {
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

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('receive_message', {
      message,
      fromUserId: userId,
      timestamp: timestamp.getTime(),
    });

    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const sendRandomMessage = async (req, res) => {
  try {
    const { userId, partnerId, message } = req.body;

    if (!userId || !partnerId || !message || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(partnerId)) {
      return res.status(400).json({ message: 'Invalid userId, partnerId, or message.' });
    }

    const room = activeRooms.get(userId);
    if (!room || room.type !== 'random' || room.partnerId !== partnerId) {
      return res.status(403).json({ message: 'Not in a random chat with this user.' });
    }

    res.status(200).json({ message: 'Message sent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getChatHistory = async (req, res) => {
  try {
    const { userId, friendId } = req.params;

    if (!userId || !friendId || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      return res.status(400).json({ message: 'Invalid userId or friendId.' });
    }

    const chat = await Chat.findOne({
      participants: { $all: [userId, friendId] },
    });

    res.status(200).json({ messages: chat ? chat.messages : [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const markMessageSeen = async (req, res) => {
  try {
    const { userId, friendId, timestamp } = req.body;

    if (!userId || !friendId || !timestamp || !/^[0-9a-fA-F]{24}$/.test(userId) || !/^[0-9a-fA-F]{24}$/.test(friendId)) {
      return res.status(400).json({ message: 'Invalid userId, friendId, or timestamp.' });
    }

    const chat = await Chat.findOne({
      participants: { $all: [userId, friendId] },
    });

    if (!chat) {
      return res.status(404).json({ message: 'Chat not found.' });
    }

    const message = chat.messages.find(
      (msg) => msg.timestamp.getTime() === timestamp && msg.senderId.toString() === friendId
    );

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    message.seen = true;
    await chat.save();

    const roomId = [userId, friendId].sort().join('_');
    req.io.to(roomId).emit('message_seen', { fromUserId: userId, timestamp });

    res.status(200).json({ message: 'Message marked as seen.' });
  } catch (err) {
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