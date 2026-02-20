const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    user_name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 2,
      maxlength: 30,
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Unknown'],
      required: true,
    },
    bio: {
      type: String,
      default: '',
      maxlength: 300,
      trim: true,
    },
    interests: [{ type: String, trim: true }],
    profilePicture: {
      type: String,
      default: null,
    },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    friendRequests: [
      {
        fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
      },
    ],
    isActive: { type: Boolean, default: true },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// user_name already indexed via unique:true above
userSchema.index({ friends: 1 });

module.exports = mongoose.model('User', userSchema);
