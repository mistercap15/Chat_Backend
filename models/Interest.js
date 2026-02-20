const mongoose = require('mongoose');

const interestSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: 'General',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// name already indexed via unique:true above
interestSchema.index({ category: 1 });

module.exports = mongoose.model('Interest', interestSchema);
