const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  user_name: { type: String, required: true },
  gender: {
    type: String,
    enum: ['male', 'female', 'anonymous'],
    default: 'anonymous'
  },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  interests: [String],
});

const User = mongoose.model('User', userSchema);

module.exports = User;
