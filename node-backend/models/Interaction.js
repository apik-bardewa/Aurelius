const mongoose = require('mongoose');

/**
 * Interaction
 *
 * Immutable event log. Every user–article signal is written here exactly once.
 * The interaction pipeline reads from this collection to update User.topicScores
 * and User.profileEmbedding.
 *
 * Design decisions:
 *   - One document per event (not one per article per user). This keeps writes
 *     simple and allows the pipeline to replay history.
 *   - Score is pre-computed by the client using the canonical scoring table and
 *     validated server-side. Do not trust client scores blindly — the controller
 *     should re-derive the score from `type` on the server.
 *   - TTL index auto-deletes documents older than 90 days to bound collection size.
 *     Topic scores and embeddings are the durable signal; raw events are transient.
 */

/**
 * Canonical scoring table.
 * Exported so controllers and tests can import it from a single source of truth.
 */
const INTERACTION_SCORES = Object.freeze({
  view:      1,
  read_30:   2,  // read for > 30 seconds
  read_60:   4,  // read for > 60 seconds
  like:      5,
  bookmark:  8,
  comment:   10,
  share:     12,
});

const INTERACTION_TYPES = Object.keys(INTERACTION_SCORES);

const InteractionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    articleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Article',
      required: true,
      index: true,
    },

    /**
     * Interaction category. Server MUST re-derive `score` from this field;
     * never trust the client-supplied score directly.
     */
    type: {
      type: String,
      enum: INTERACTION_TYPES,
      required: true,
    },

    /**
     * Points contributed to topicScores and the profile embedding update.
     * Derived from `type` via INTERACTION_SCORES on the server side.
     */
    score: {
      type: Number,
      required: true,
      min: 1,
    },

    /**
     * Article topics at the time of interaction, copied from Article.topics.
     * Denormalized here so the pipeline doesn't need to re-fetch the article
     * when updating User.topicScores.
     */
    topics: {
      type: [String],
      default: [],
    },

    /**
     * Milliseconds the article was visible and focused in the viewport.
     * Measured client-side with IntersectionObserver + performance.now().
     * Used for analytics; read_30 / read_60 classification is done client-side
     * before sending the event.
     */
    readTimeMs: {
      type: Number,
      default: 0,
      min: 0,
    },

    /**
     * Client session ID for deduplication.
     * A (userId, articleId, type, sessionId) tuple must be unique per session
     * to prevent double-counting if the client retries a failed batch flush.
     */
    sessionId: {
      type: String,
      required: true,
    },

    /**
     * UTC timestamp when the interaction occurred on the client.
     * May differ from createdAt (server time) if the client was offline.
     */
    clientTimestamp: {
      type: Date,
      default: null,
    },

    /**
     * Which batch this event was part of (useful for replaying failed batches).
     */
    batchId: {
      type: String,
      default: null,
    },

    /**
     * True once this interaction has been processed by the profile-update pipeline.
     * The pipeline sets this to true after it has updated User.topicScores and
     * enqueued the embedding update.
     */
    isProcessed: {
      type: Boolean,
      default: false,
      index: true,
    },

    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt used as the TTL field
    toJSON: { versionKey: false },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// Primary access patterns
InteractionSchema.index({ userId: 1, createdAt: -1 });                // user history feed
InteractionSchema.index({ articleId: 1, type: 1 });                   // article analytics
InteractionSchema.index({ userId: 1, articleId: 1, type: 1 });        // "has user liked this article?"
InteractionSchema.index({ isProcessed: 1, createdAt: 1 });            // pipeline catch-up query

// Dedup index — prevents double-counting retried batch flushes
InteractionSchema.index(
  { userId: 1, articleId: 1, type: 1, sessionId: 1 },
  { unique: true }
);

// TTL — auto-delete raw events after 90 days
// Durable signal lives in User.topicScores; raw events are transient
InteractionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Derive the canonical server-side score for an interaction type.
 * Always use this — never trust a client-supplied score.
 * @param {string} type
 * @returns {number}
 */
InteractionSchema.statics.scoreForType = function (type) {
  const score = INTERACTION_SCORES[type];
  if (score === undefined) throw new Error(`Unknown interaction type: ${type}`);
  return score;
};

/**
 * Bulk-insert interactions from a client batch flush.
 * Uses ordered:false so a single duplicate doesn't abort the whole batch.
 * Returns counts of inserted and skipped (duplicate) documents.
 *
 * @param {object[]} events - raw events from the client payload
 * @param {mongoose.Types.ObjectId} userId
 * @param {string} batchId
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
InteractionSchema.statics.insertBatch = async function (events, userId, batchId) {
  const docs = events.map((e) => ({
    userId,
    articleId: e.articleId,
    type: e.type,
    score: INTERACTION_SCORES[e.type], // server-derived, not client-supplied
    topics: e.topics || [],
    readTimeMs: e.readTimeMs || 0,
    sessionId: e.sessionId,
    clientTimestamp: e.timestamp ? new Date(e.timestamp) : null,
    batchId,
    isProcessed: false,
  }));

  try {
    const result = await this.insertMany(docs, { ordered: false });
    return { inserted: result.length, skipped: events.length - result.length };
  } catch (err) {
    // BulkWriteError: partial success — some docs inserted, some were duplicates
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      const inserted = err.result?.nInserted ?? 0;
      return { inserted, skipped: events.length - inserted };
    }
    throw err;
  }
};

/**
 * Fetch unprocessed interactions for the profile-update pipeline.
 * @param {number} [limit=500]
 * @returns {Promise<import('mongoose').Document[]>}
 */
InteractionSchema.statics.findUnprocessed = function (limit = 500) {
  return this.find({ isProcessed: false })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
};

/**
 * Return aggregated topic scores for a user over the last N days.
 * Used by the profile rebuild job when profileEmbedding needs a full reset.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {number} [days=30]
 * @returns {Promise<{ topic: string, totalScore: number }[]>}
 */
InteractionSchema.statics.aggregateTopicScores = function (userId, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  return this.aggregate([
    { $match: { userId, createdAt: { $gte: since } } },
    { $unwind: '$topics' },
    {
      $group: {
        _id: '$topics',
        totalScore: { $sum: '$score' },
        eventCount: { $sum: 1 },
      },
    },
    { $project: { topic: '$_id', totalScore: 1, eventCount: 1, _id: 0 } },
    { $sort: { totalScore: -1 } },
  ]);
};

// Attach the scoring table so importers can use it
InteractionSchema.statics.INTERACTION_SCORES = INTERACTION_SCORES;
InteractionSchema.statics.INTERACTION_TYPES  = INTERACTION_TYPES;

const Interaction = mongoose.model('Interaction', InteractionSchema);

module.exports = Interaction;
module.exports.INTERACTION_SCORES = INTERACTION_SCORES;
module.exports.INTERACTION_TYPES  = INTERACTION_TYPES;