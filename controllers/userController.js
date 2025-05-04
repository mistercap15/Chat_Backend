const User = require('../models/User');

exports.createUser = async (req, res) => {
  try {
    const { user_name, gender, interests } = req.body;
    const user = new User({ user_name, gender, interests });
    await user.save();
    res.status(201).json({ user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.addFriend = async (req, res) => {
  try {
    const { userId, friendId } = req.body;
    const user = await User.findById(userId);
    const friend = await User.findById(friendId);
    
    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add each other as friends
    if (!user.friends.includes(friendId)) user.friends.push(friendId);
    if (!friend.friends.includes(userId)) friend.friends.push(userId);

    await user.save();
    await friend.save();

    res.status(200).json({ message: 'Friend added successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.removeFriend = async (req, res) => {
  try {
    const { userId, friendId } = req.body;
    const user = await User.findById(userId);
    const friend = await User.findById(friendId);

    if (!user || !friend) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Remove each other as friends
    user.friends = user.friends.filter(friend => friend.toString() !== friendId);
    friend.friends = friend.friends.filter(friend => friend.toString() !== userId);

    await user.save();
    await friend.save();

    res.status(200).json({ message: 'Friend removed successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
