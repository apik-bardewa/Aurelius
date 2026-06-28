const mongoose = require('mongoose');

/**
 * InterestHistory
 *
 * Append-only audit log of every change to a user's interest profile.
 * A new document is written whenever:
 *   - The user selects interests at signup              (trigger: 'signup')
 *   - The user manually updates their interests         (trigger: 'manual_update')
 *   - The interaction pipeline updates topicScores      (trigger: 'interaction_batch')
 *   - The profile-rebuild job resets the embedding      (trigger: 'profile_rebuild')
 *
 * This collection serves three purposes:
 *   1. Debuggability — why is this user seeing these articles? Replay history.
 *   2. ML training data — pairs of (embedding_before, interactions) → embedding_after.
 *   3. Rollback — if a pipeline bug corrupts topicScores, restore from the last snapshot.
 *
 * Documents are never updated; only inserted. Large arrays (topicScoresBefore/After,
 * embeddingBefore/After) are stored in full to make each document self-contained.
 *
 * Storage estimate: 2 × 384 floats × 8 bytes ≈ 6KB per document.
 * At 10 updates/user/day × 1M users × 90 days TTL ≈ 540 GB — shard or use S3
 * for embedding snapshots at scale. For < 100K users, inline storage is fine.
 */
const InterestHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * What caused this change.
     *   signup             → first interest selection
     *   manual_update      → user changed topics on settings page
     *   interaction_batch  → pipeline processed a batch of interactions
     *   profile_rebuild    → full recomputation from interaction history
     */
    trigger: {
      type: String,
      enum: ['signup', 'manual_update', 'interaction_batch', 'profile_rebuild'],
      required: true,
    },

    // ── Topic score diff ──────────────────────────────────────────────────────

    /**
     * Full topicScores map before this change.
     * Example: { AI: 32.1, Finance: 11.8 }
     */
    topicScoresBefore: {
      type: Map,
      of: Number,
      default: {},
    },

    /**
     * Full topicScores map after this change.
     */
    topicScoresAfter: {
      type: Map,
      of: Number,
      default: {},
    },

    /**
     * Only the topics that changed (added, removed, or score changed significantly).
     * Computed by the pipeline for quick diff queries.
     * Example: [{ topic: 'AI', before: 32.1, after: 38.6, delta: 6.5 }]
     */
    topicDiffs: {
      type: [
        {
          topic:  { type: String },
          before: { type: Number, default: 0 },
          after:  { type: Number, default: 0 },
          delta:  { type: Number },
          _id: false,
        },
      ],
      default: [],
    },

    // ── Embedding snapshots ───────────────────────────────────────────────────

    /**
     * 384-dim profile vector before this update.
     * Empty array if this is the first embedding (signup before embed is ready).
     */
    embeddingBefore: {
      type: [Number],
      default: [],
      validate: {
        validator: (v) => v.length === 0 || v.length === 384,
        message: 'embeddingBefore must be empty or 384 dimensions',
      },
    },

    /**
     * 384-dim profile vector after this update.
     */
    embeddingAfter: {
      type: [Number],
      default: [],
      validate: {
        validator: (v) => v.length === 0 || v.length === 384,
        message: 'embeddingAfter must be empty or 384 dimensions',
      },
    },

    /**
     * Cosine similarity between embeddingBefore and embeddingAfter.
     * 1.0 = no change, 0.0 = completely different direction.
     * Computed and stored by the pipeline for cheap trend queries.
     * null if either vector is empty.
     */
    embeddingSimilarity: {
      type: Number,
      default: null,
      min: -1,
      max: 1,
    },

    // ── Interaction context (for interaction_batch trigger) ───────────────────

    /**
     * Summary of the interaction batch that triggered this update.
     * Only populated when trigger = 'interaction_batch'.
     */
    batchSummary: {
      batchId:        { type: String, default: null },
      eventCount:     { type: Number, default: 0 },
      totalScore:     { type: Number, default: 0 },
      topicsAffected: { type: [String], default: [] },
    },

    // ── Manual update context ─────────────────────────────────────────────────

    /**
     * Topics the user explicitly added or removed.
     * Only populated when trigger = 'manual_update'.
     */
    topicsAdded:   { type: [String], default: [] },
    topicsRemoved: { type: [String], default: [] },

    /**
     * Whether this snapshot has been used to retrain or fine-tune any model.
     * Set by the ML pipeline. Not consumed by the application layer.
     */
    usedForTraining: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,           // createdAt is the event timestamp
    toJSON: { versionKey: false },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

InterestHistorySchema.index({ userId: 1, createdAt: -1 });
InterestHistorySchema.index({ userId: 1, trigger: 1, createdAt: -1 });
InterestHistorySchema.index({ trigger: 1, createdAt: -1 });           // pipeline stats
InterestHistorySchema.index({ usedForTraining: 1, trigger: 1 });      // ML pipeline query

// TTL — auto-delete history older than 90 days
// Aggregate metrics should be computed and stored before this fires
InterestHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two unit-normalized vectors.
 * Both must have the same length; pre-normalized vectors make this a dot product.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number|null}
 */
function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  // Vectors are expected to be unit-normalized (‖v‖=1) so sim = dot product
  return a.reduce((sum, ai, i) => sum + ai * b[i], 0);
}

/**
 * Record a profile change.
 * Computes similarity and topic diffs automatically.
 *
 * @param {object} params
 * @param {mongoose.Types.ObjectId} params.userId
 * @param {string} params.trigger
 * @param {Map|object} params.topicScoresBefore
 * @param {Map|object} params.topicScoresAfter
 * @param {number[]} [params.embeddingBefore=[]]
 * @param {number[]} [params.embeddingAfter=[]]
 * @param {object} [params.batchSummary={}]
 * @param {string[]} [params.topicsAdded=[]]
 * @param {string[]} [params.topicsRemoved=[]]
 * @returns {Promise<import('mongoose').Document>}
 */
InterestHistorySchema.statics.record = function ({
  userId,
  trigger,
  topicScoresBefore = {},
  topicScoresAfter  = {},
  embeddingBefore   = [],
  embeddingAfter    = [],
  batchSummary      = {},
  topicsAdded       = [],
  topicsRemoved     = [],
}) {
  // Normalize Map → plain object for storage
  const before = topicScoresBefore instanceof Map
    ? Object.fromEntries(topicScoresBefore)
    : topicScoresBefore;
  const after = topicScoresAfter instanceof Map
    ? Object.fromEntries(topicScoresAfter)
    : topicScoresAfter;

  // Compute topic diffs — only include topics where score changed by > 0.01
  const allTopics = new Set([...Object.keys(before), ...Object.keys(after)]);
  const topicDiffs = [];
  for (const topic of allTopics) {
    const b = before[topic] || 0;
    const a = after[topic]  || 0;
    const delta = a - b;
    if (Math.abs(delta) > 0.01) topicDiffs.push({ topic, before: b, after: a, delta });
  }

  const embeddingSimilarity = cosineSimilarity(embeddingBefore, embeddingAfter);

  return this.create({
    userId,
    trigger,
    topicScoresBefore: before,
    topicScoresAfter:  after,
    topicDiffs,
    embeddingBefore,
    embeddingAfter,
    embeddingSimilarity,
    batchSummary,
    topicsAdded,
    topicsRemoved,
  });
};

/**
 * Return recent history for a user, newest first.
 * @param {mongoose.Types.ObjectId} userId
 * @param {number} [limit=20]
 * @param {string} [trigger]  - optional filter by trigger type
 * @returns {Promise<import('mongoose').Document[]>}
 */
InterestHistorySchema.statics.getForUser = function (userId, limit = 20, trigger = null) {
  const query = { userId };
  if (trigger) query.trigger = trigger;
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-embeddingBefore -embeddingAfter') // omit heavy arrays from list view
    .lean();
};

/**
 * Return the most recent snapshot with both embeddings, for ML training pipelines.
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<import('mongoose').Document|null>}
 */
InterestHistorySchema.statics.getLatestEmbeddingSnapshot = function (userId) {
  return this.findOne({
    userId,
    $expr: { $gt: [{ $size: '$embeddingAfter' }, 0] },
  })
    .sort({ createdAt: -1 })
    .lean();
};

const InterestHistory = mongoose.model('InterestHistory', InterestHistorySchema);

module.exports = InterestHistory;