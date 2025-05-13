const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  user_name: { type: String, required: true, unique: true },
  gender: { type: String, enum: ['Male', 'Female', 'Unknown'], required: true },
  bio: { type: String, default: '' },
  interests: [{ type: String }],
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [
    {
      fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
    },
  ],
});

module.exports = mongoose.model('User', userSchema);