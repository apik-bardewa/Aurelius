const mongoose = require('mongoose');

const InterestHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  trigger: {
    // What caused this update
    type: String,
    enum: ['signup', 'manual_update', 'interaction_batch'],
    required: true,
  },
  topicsBefore: {
    // Topic list before the change
    type: [String],
    default: [],
  },
  topicsAfter: {
    // Topic list after the change
    type: [String],
    default: [],
  },
  topicScoresBefore: {
    // Score map before the change e.g. { AI: 20, Finance: 8 }
    type: Map,
    of: Number,
    default: {},
  },
  topicScoresAfter: {
    type: Map,
    of: Number,
    default: {},
  },
}, { timestamps: true });

// Newest history first per user
InterestHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('InterestHistory', InterestHistorySchema);