const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  seen: { type: Boolean, default: false },
});

const chatSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  participantsHash: { type: String, required: true, unique: true },
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

chatSchema.index({ participants: 1 }); // Optimize queries by participants
chatSchema.index({ participantsHash: 1 }, { unique: true });
chatSchema.index({ updatedAt: -1 });
chatSchema.index({ 'messages.timestamp': -1 });

chatSchema.pre('save', function (next) {
  if (Array.isArray(this.participants) && this.participants.length === 2) {
    this.participantsHash = this.participants
      .map((participant) => participant.toString())
      .sort()
      .join('_');
  }
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Chat', chatSchema);
