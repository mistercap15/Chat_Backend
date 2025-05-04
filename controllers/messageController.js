const Message = require('../models/Message');

exports.sendMessage = async (req, res) => {
  try {
    const { senderId, receiverId, messageText } = req.body;

    const sender = await User.findById(senderId);
    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!sender.friends.includes(receiverId)) {
      return res.status(400).json({ message: 'You are not friends with this user' });
    }

    // Save the message
    const message = new Message({
      sender: senderId,
      receiver: receiverId,
      message: messageText,
    });

    await message.save();

    res.status(200).json({ message: 'Message sent successfully', message });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getChatHistory = async (req, res) => {
  try {
    const { userId, friendId } = req.query;

    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User or Friend not found' });
    }

    // Ensure the users are friends
    if (!user.friends.includes(friendId) || !friend.friends.includes(userId)) {
      return res.status(400).json({ message: 'These users are not friends' });
    }

    // Get the chat history between the users
    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: friendId },
        { sender: friendId, receiver: userId }
      ]
    }).sort({ timestamp: 1 }); // Sort by timestamp to show the chat in the right order

    res.status(200).json({ messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
