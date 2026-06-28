const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

/**
 * User
 *
 * Core auth + profile document.
 * profileEmbedding is the live 384-dim vector (all-MiniLM-L6-v2) that drives FAISS search.
 * topicScores is a dynamic map updated by the interaction pipeline with exponential decay.
 * seenArticleIds is a rolling window (capped at 1000) used by the rec engine to filter duplicates.
 */
const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
      index: true,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false, // never returned in queries unless explicitly requested
    },

    displayName: {
      type: String,
      trim: true,
      maxlength: [80, 'Display name must be 80 characters or fewer'],
    },

    avatarUrl: {
      type: String,
      default: null,
    },

    // ── Interest profile ──────────────────────────────────────────────────────

    /**
     * Initial topic labels selected at signup, e.g. ['AI', 'Finance', 'Health'].
     * Used as the cold-start seed for the profile embedding and as a fallback
     * when topicScores has insufficient signal.
     */
    interests: {
      type: [String],
      default: [],
      validate: {
        validator: (v) => v.length >= 1,
        message: 'At least one interest is required',
      },
    },

    /**
     * Continuously evolving per-topic score map.
     * Updated by the interaction pipeline:
     *   newScore = oldScore * DECAY_FACTOR + interactionScore
     * where DECAY_FACTOR = 0.995 (recent interactions outweigh old ones).
     *
     * Example: { AI: 42.3, Finance: 11.8, Sports: 3.2 }
     */
    topicScores: {
      type: Map,
      of: Number,
      default: {},
    },

    /**
     * 384-dimensional unit-normalized float vector produced by all-MiniLM-L6-v2.
     * Stored as a plain array so it can be serialized to Python FastAPI without
     * conversion overhead. Updated asynchronously by the profile-update worker.
     */
    profileEmbedding: {
      type: [Number],
      default: [],
      validate: {
        validator: (v) => v.length === 0 || v.length === 384,
        message: 'profileEmbedding must be empty or exactly 384 dimensions',
      },
    },

    embeddingUpdatedAt: {
      type: Date,
      default: null,
    },

    // ── Feed state ────────────────────────────────────────────────────────────

    /**
     * Rolling list of article IDs already served to this user.
     * Capped at 1000 entries (oldest dropped first) to bound document size.
     * The rec engine filters these out before returning recommendations.
     */
    seenArticleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },

    // ── Account status ────────────────────────────────────────────────────────

    isActive: {
      type: Boolean,
      default: true,
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    /**
     * Opaque token stored here and in Redis.
     * Validated on /auth/refresh; rotated on each use (one-time).
     */
    refreshTokenHash: {
      type: String,
      select: false,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.refreshTokenHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ isActive: 1 });

// ── Virtuals ──────────────────────────────────────────────────────────────────

UserSchema.virtual('hasProfileEmbedding').get(function () {
  return this.profileEmbedding && this.profileEmbedding.length === 384;
});

// ── Pre-save hooks ────────────────────────────────────────────────────────────

UserSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();
  // Caller passes plain password as passwordHash; hook hashes it before persist.
  this.passwordHash = await bcrypt.hash(this.passwordHash, SALT_ROUNDS);
  next();
});

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Compare a plain-text password against the stored hash.
 * @param {string} plainPassword
 * @returns {Promise<boolean>}
 */
UserSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

/**
 * Append article IDs to seenArticleIds, capping the list at 1000.
 * Call this after serving a batch of recommendations.
 * @param {mongoose.Types.ObjectId[]} articleIds
 */
UserSchema.methods.markArticlesSeen = function (articleIds) {
  const merged = [...this.seenArticleIds, ...articleIds];
  this.seenArticleIds = merged.slice(-1000); // keep most recent 1000
};

/**
 * Apply exponential decay to topicScores and add new interaction scores.
 * @param {{ topic: string, score: number }[]} interactions
 * @param {number} [decayFactor=0.995]
 */
UserSchema.methods.updateTopicScores = function (interactions, decayFactor = 0.995) {
  // Decay all existing scores
  for (const [topic, score] of this.topicScores.entries()) {
    this.topicScores.set(topic, score * decayFactor);
  }
  // Add new interaction scores
  for (const { topic, score } of interactions) {
    const current = this.topicScores.get(topic) || 0;
    this.topicScores.set(topic, current + score);
  }
};

// ── Static methods ────────────────────────────────────────────────────────────

/**
 * Find a user by email and return with passwordHash included (needed for login).
 * @param {string} email
 * @returns {Promise<import('mongoose').Document>}
 */
UserSchema.statics.findByEmailWithPassword = function (email) {
  return this.findOne({ email: email.toLowerCase() }).select('+passwordHash');
};

const User = mongoose.model('User', UserSchema);

module.exports = User;