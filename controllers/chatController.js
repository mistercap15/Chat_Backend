let searchingUsers = [];
let pairedUsers = {};

const handleSocketConnection = (socket, io) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('start_search', async ({ userId }) => {
    console.log(`User ${userId} started searching`);
    // Remove any stale entries for this userId
    searchingUsers = searchingUsers.filter((user) => user.userId !== userId);
    const availableUser = searchingUsers.find((user) => user.userId !== userId);

    if (availableUser) {
      pairedUsers[userId] = socket.id;
      pairedUsers[availableUser.userId] = availableUser.socketId;

      console.log(`Paired ${userId} (socket ${socket.id}) with ${availableUser.userId} (socket ${availableUser.socketId})`);
      console.log('Current pairedUsers:', pairedUsers);

      io.to(socket.id).emit('match_found', { partnerId: availableUser.userId });
      io.to(availableUser.socketId).emit('match_found', { partnerId: userId });

      io.to(socket.id).emit('test_event', { message: `Test event for ${userId}` });
      io.to(availableUser.socketId).emit('test_event', { message: `Test event for ${availableUser.userId}` });

      searchingUsers = searchingUsers.filter(
        (user) => user.userId !== availableUser.userId && user.userId !== userId
      );
    } else {
      searchingUsers.push({ userId, socketId: socket.id });
      console.log(`Added ${userId} to searchingUsers:`, searchingUsers);
    }
  });

  socket.on('send_message', ({ toUserId, message, fromUserId }) => {
    const partnerSocketId = pairedUsers[toUserId];
    console.log(`Received message from ${fromUserId} to ${toUserId}: ${message}`);
    console.log(`Looking up socket for ${toUserId}: ${partnerSocketId}`);
    console.log(`Sender socket.id: ${socket.id}`);

    if (partnerSocketId && partnerSocketId !== socket.id) {
      const socketExists = io.sockets.sockets.get(partnerSocketId);
      if (socketExists) {
        console.log(`Emitting message to socket ${partnerSocketId} (user ${toUserId}): ${message}`);
        io.to(partnerSocketId).emit('receive_message', { message, fromUserId });
      } else {
        console.log(`Socket ${partnerSocketId} for user ${toUserId} is no longer connected`);
      }
    } else {
      console.log(`No valid partner socket found for user ${toUserId} or sender socket matched`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    // Remove from searching users
    searchingUsers = searchingUsers.filter((user) => user.socketId !== socket.id);

    // Find the disconnected user and their partner
    let disconnectedUserId = null;
    let partnerUserId = null;

    // Find the userId associated with this socket
    for (const [userId, socketId] of Object.entries(pairedUsers)) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      // Find the partner's userId
      for (const [userId, socketId] of Object.entries(pairedUsers)) {
        if (userId !== disconnectedUserId) {
          partnerUserId = userId;
          break;
        }
      }

      // Notify the partner and clean up
      if (partnerUserId) {
        const partnerSocketId = pairedUsers[partnerUserId];
        if (partnerSocketId && io.sockets.sockets.get(partnerSocketId)) {
          console.log(`Notifying partner ${partnerUserId} (socket ${partnerSocketId}) that user ${disconnectedUserId} disconnected`);
          io.to(partnerSocketId).emit('partner_disconnected', { disconnectedUserId });
        } else {
          console.log(`Partner ${partnerUserId} socket ${partnerSocketId} is not connected`);
        }
      }

      // Remove both users from pairedUsers
      delete pairedUsers[disconnectedUserId];
      delete pairedUsers[partnerUserId];
    }

    console.log('Updated pairedUsers after disconnect:', pairedUsers);
  });
};

module.exports = { handleSocketConnection };