const mongoose = require('mongoose');

// Canonical score for each interaction type
const SCORES = {
  view:      1,
  read_30:   2,   // user read for > 30 seconds
  read_60:   4,   // user read for > 60 seconds
  like:      5,
  bookmark:  8,
  comment:   10,
  share:     12,
};

const InteractionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  articleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Article',
    required: true,
  },
  type: {
    type: String,
    enum: Object.keys(SCORES),
    required: true,
  },
  score: {
    // Derived from type on the server — never trust the client value
    type: Number,
    required: true,
  },
  topics: {
    // Article topics copied here so the pipeline doesn't re-fetch the article
    type: [String],
    default: [],
  },
  readTimeMs: {
    type: Number,
    default: 0,
  },
  sessionId: {
    // Client session UUID — used to deduplicate retried batch flushes
    type: String,
    default: null,
  },
}, { timestamps: true });

// Prevent duplicate events for the same (user, article, type) in one session
InteractionSchema.index(
  { userId: 1, articleId: 1, type: 1, sessionId: 1 },
  { unique: true, sparse: true }
);

// Expose score table so controllers import it from here
InteractionSchema.statics.SCORES = SCORES;

module.exports = mongoose.model('Interaction', InteractionSchema);