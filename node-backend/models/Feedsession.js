const mongoose = require('mongoose');

const FeedSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  sessionId: {
    // Client-generated UUID sent with every interaction batch
    type: String,
    required: true,
    unique: true,
  },
  articlesViewed: {
    // Total article cards that entered the viewport this session
    type: Number,
    default: 0,
  },
  lastCursor: {
    // Last feed page cursor position — lets infinite scroll resume after refresh
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('FeedSession', FeedSessionSchema);