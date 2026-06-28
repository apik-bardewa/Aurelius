const mongoose = require('mongoose');

/**
 * FeedSession
 *
 * Represents one continuous scroll session on the feed page.
 * A session starts when the user opens the feed and ends when:
 *   - The user navigates away (beforeunload / sendBeacon flush)
 *   - The client explicitly calls POST /feed/sessions/:id/end
 *   - No activity for 30 minutes (TTL enforced by the background job)
 *
 * Purpose:
 *   1. Deduplication — the batch interaction flush includes a sessionId.
 *      The Interaction model uses (userId, articleId, type, sessionId) as
 *      a unique key, so retried flushes don't double-count.
 *
 *   2. Analytics — how many articles did users scroll past before engaging?
 *      What is the average session depth? Which cohorts have short sessions?
 *
 *   3. Feed cursor — the session stores which recommendation cursor position
 *      was reached so infinite scroll can resume after a page refresh
 *      (optional — requires the client to store the sessionId in localStorage).
 *
 * Sessions are separate from JWT sessions (which are tracked in Redis).
 * One user can have multiple concurrent FeedSessions on different devices.
 */
const FeedSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * Opaque client-generated UUID sent with every batch flush.
     * Format: client decides (UUIDv4 recommended).
     */
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ── Session lifecycle ─────────────────────────────────────────────────────

    /**
     * UTC timestamp when the first feed request was made in this session.
     */
    startedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },

    endedAt: {
      type: Date,
      default: null,
    },

    /**
     * Duration in seconds. Written when the session ends.
     * null while the session is still active.
     */
    durationSeconds: {
      type: Number,
      default: null,
    },

    /**
     * 'active'  → session is ongoing
     * 'ended'   → client sent an explicit end event
     * 'expired' → closed by the 30-minute idle TTL job
     */
    status: {
      type: String,
      enum: ['active', 'ended', 'expired'],
      default: 'active',
      index: true,
    },

    // ── Feed cursor state ─────────────────────────────────────────────────────

    /**
     * The last recommendation cursor position reached.
     * Updated every time the client fetches a new page of the feed.
     * 0-based offset into the recommendation result set.
     */
    lastCursor: {
      type: Number,
      default: 0,
    },

    /**
     * Total number of article cards that entered the viewport during this session.
     * Incremented by the batch flush handler.
     */
    articlesViewed: {
      type: Number,
      default: 0,
    },

    /**
     * Number of batch flushes received from the client in this session.
     * Useful for detecting abnormal behaviour (e.g. bots that flush every second).
     */
    batchFlushCount: {
      type: Number,
      default: 0,
    },

    // ── Engagement snapshot ───────────────────────────────────────────────────

    /**
     * Counts of each interaction type during this session.
     * Updated by the batch flush handler. Used for per-session analytics dashboards.
     */
    engagementCounts: {
      views:     { type: Number, default: 0 },
      reads30:   { type: Number, default: 0 },
      reads60:   { type: Number, default: 0 },
      likes:     { type: Number, default: 0 },
      bookmarks: { type: Number, default: 0 },
      comments:  { type: Number, default: 0 },
      shares:    { type: Number, default: 0 },
    },

    /**
     * Total interaction score accumulated this session.
     * Sum of all event scores (view=1, share=12, etc.)
     */
    totalScore: {
      type: Number,
      default: 0,
    },

    // ── Device / client context ───────────────────────────────────────────────

    /**
     * User-Agent header captured at session start.
     */
    userAgent: {
      type: String,
      default: null,
    },

    /**
     * Client-reported platform.
     */
    platform: {
      type: String,
      enum: ['web', 'ios', 'android', 'unknown'],
      default: 'unknown',
    },

    /**
     * IP address at session start (for geo-analytics, not stored long-term).
     * Hashed before storage to comply with GDPR.
     */
    ipHash: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { versionKey: false },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

FeedSessionSchema.index({ userId: 1, startedAt: -1 });
FeedSessionSchema.index({ status: 1, startedAt: 1 });  // expired session cleanup job
FeedSessionSchema.index({ sessionId: 1 }, { unique: true });

// TTL — remove session documents 7 days after creation
// (analytics data is aggregated into a separate collection before this fires)
FeedSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Record a batch flush from the client.
 * Updates engagement counts and marks the flush.
 *
 * @param {{ type: string, score: number }[]} events
 * @param {number} newCursor
 */
FeedSessionSchema.methods.recordBatchFlush = function (events, newCursor) {
  this.batchFlushCount += 1;
  this.lastCursor = Math.max(this.lastCursor, newCursor);

  const typeToField = {
    view:     'views',
    read_30:  'reads30',
    read_60:  'reads60',
    like:     'likes',
    bookmark: 'bookmarks',
    comment:  'comments',
    share:    'shares',
  };

  for (const event of events) {
    const field = typeToField[event.type];
    if (field) this.engagementCounts[field] += 1;
    if (event.type === 'view') this.articlesViewed += 1;
    this.totalScore += event.score || 0;
  }

  return this.save();
};

/**
 * Mark this session as ended and compute duration.
 */
FeedSessionSchema.methods.end = function () {
  this.status = 'ended';
  this.endedAt = new Date();
  this.durationSeconds = Math.round((this.endedAt - this.startedAt) / 1000);
  return this.save();
};

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Find or create the active session for a given sessionId.
 * If the session doesn't exist (first batch flush of a new session),
 * create it with the provided metadata.
 *
 * @param {string} sessionId
 * @param {mongoose.Types.ObjectId} userId
 * @param {object} meta  - { userAgent, platform, ipHash }
 * @returns {Promise<import('mongoose').Document>}
 */
FeedSessionSchema.statics.findOrCreate = function (sessionId, userId, meta = {}) {
  return this.findOneAndUpdate(
    { sessionId },
    {
      $setOnInsert: {
        userId,
        sessionId,
        startedAt: new Date(),
        status: 'active',
        ...meta,
      },
    },
    { upsert: true, new: true }
  );
};

/**
 * Expire sessions that have had no batch flush in the last 30 minutes.
 * Called by the background job every 5 minutes.
 * @returns {Promise<number>} number of sessions expired
 */
FeedSessionSchema.statics.expireIdle = async function () {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const result = await this.updateMany(
    { status: 'active', updatedAt: { $lt: cutoff } },
    { $set: { status: 'expired', endedAt: cutoff } }
  );
  return result.modifiedCount;
};

const FeedSession = mongoose.model('FeedSession', FeedSessionSchema);

module.exports = FeedSession;