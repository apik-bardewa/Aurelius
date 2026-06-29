const mongoose = require('mongoose');

const UserInterestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  topics: {
    // Topics the user explicitly selected e.g. ['AI', 'Health', 'Programming']
    type: [String],
    required: true,
  },
  topicScores: {
    // Running score per topic, updated after each interaction batch
    // e.g. { AI: 24, Finance: 8 }
    type: Map,
    of: Number,
    default: {},
  },
}, { timestamps: true });

module.exports = mongoose.model('UserInterest', UserInterestSchema);