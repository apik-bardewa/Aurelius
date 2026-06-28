const mongoose = require('mongoose');

/**
 * Article
 *
 * Represents a single article parsed from an XML source file.
 * faissId is the integer assigned by FAISS during indexing and is the key
 * that links this document to the vector search layer.
 *
 * Popularity scoring is maintained by a background aggregation job that
 * runs every 15 minutes and writes the result back to popularityScore.
 */
const ArticleSchema = new mongoose.Schema(
  {
    // ── Content ───────────────────────────────────────────────────────────────

    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [500, 'Title must be 500 characters or fewer'],
    },

    /**
     * Full article body extracted from XML.
     * Stored here for keyword search and reading-time calculation.
     * Not returned in feed API responses (summary is used there instead).
     */
    body: {
      type: String,
      required: [true, 'Body is required'],
    },

    /**
     * Short teaser shown in feed cards (~250 chars).
     * Either the first 250 chars of body or an explicit abstract from the XML.
     */
    summary: {
      type: String,
      maxlength: [600, 'Summary must be 600 characters or fewer'],
      default: '',
    },

    /**
     * Cover image served in feed cards.
     * Stored in S3-compatible object storage; URL written here after upload.
     */
    imageUrl: {
      type: String,
      default: null,
    },

    // ── Attribution ───────────────────────────────────────────────────────────

    author: {
      type: String,
      trim: true,
      default: 'Unknown',
    },

    source: {
      type: String,
      trim: true,
      default: '',
    },

    /**
     * Canonical URL from the original XML.
     * Unique index — used as the dedup key during ingestion.
     */
    sourceUrl: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allow null for programmatically created articles
    },

    publishedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // ── Classification ────────────────────────────────────────────────────────

    /**
     * Topic labels assigned during XML parsing or post-hoc classification.
     * Used for topic-filtered feeds, topicScores updates, and FAISS shard routing.
     * Example: ['AI', 'Machine Learning']
     */
    topics: {
      type: [String],
      default: [],
      index: true,
    },

    /**
     * Raw language code from XML, e.g. 'en', 'fr'.
     */
    language: {
      type: String,
      default: 'en',
      lowercase: true,
    },

    /**
     * Estimated reading time in minutes.
     * Computed during ingestion: Math.ceil(wordCount / 238) (average WPM).
     */
    readTimeMin: {
      type: Number,
      default: 1,
      min: 1,
    },

    // ── Vector search ─────────────────────────────────────────────────────────

    /**
     * Sequential integer ID assigned by FAISS when the article's embedding
     * was added to the index. Used as the primary key in faiss_map.
     * Null until the ingestion pipeline processes this article.
     */
    faissId: {
      type: Number,
      default: null,
      index: true,
      sparse: true,
    },

    /**
     * Whether this article's embedding has been added to the FAISS index.
     * Used by the ingestion worker to find un-indexed articles on restart.
     */
    isIndexed: {
      type: Boolean,
      default: false,
      index: true,
    },

    indexedAt: {
      type: Date,
      default: null,
    },

    // ── Engagement counters ───────────────────────────────────────────────────

    /**
     * Denormalized counters updated by the Interaction Service.
     * Used for popularity ranking and trending feeds.
     * Source of truth for counts is the interactions collection;
     * these are updated via $inc to avoid full recounts.
     */
    stats: {
      viewCount:     { type: Number, default: 0 },
      likeCount:     { type: Number, default: 0 },
      bookmarkCount: { type: Number, default: 0 },
      commentCount:  { type: Number, default: 0 },
      shareCount:    { type: Number, default: 0 },
    },

    /**
     * Composite score computed by the trending job:
     *   popularityScore = views*1 + likes*5 + bookmarks*8 + comments*10 + shares*12
     *                     with a time decay: score * exp(-λ * ageInDays)
     * Higher values surface in trending feeds and act as a re-ranking signal.
     */
    popularityScore: {
      type: Number,
      default: 0,
      index: true,
    },

    // ── Moderation ────────────────────────────────────────────────────────────

    isPublished: {
      type: Boolean,
      default: true,
      index: true,
    },

    isRemoved: {
      type: Boolean,
      default: false,
    },

    /**
     * Raw XML source path for traceability — e.g. 'E:/wikiData/batch_01/00042.xml'.
     */
    xmlSourcePath: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v;
        delete ret.body; // never leak full body via JSON; use a dedicated route
        return ret;
      },
    },
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────

ArticleSchema.index({ topics: 1, publishedAt: -1 });
ArticleSchema.index({ topics: 1, popularityScore: -1 });
ArticleSchema.index({ isPublished: 1, publishedAt: -1 });
ArticleSchema.index({ isPublished: 1, popularityScore: -1 });
ArticleSchema.index({ faissId: 1 }, { unique: true, sparse: true });
ArticleSchema.index({ sourceUrl: 1 }, { unique: true, sparse: true });

// Full-text search index (MongoDB Atlas Search uses its own index definition;
// this covers self-hosted deployments)
ArticleSchema.index({ title: 'text', summary: 'text', topics: 'text' });

// ── Virtuals ──────────────────────────────────────────────────────────────────

ArticleSchema.virtual('ageInDays').get(function () {
  if (!this.publishedAt) return null;
  return Math.floor((Date.now() - this.publishedAt.getTime()) / 86_400_000);
});

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Increment a single stat counter atomically.
 * @param {'viewCount'|'likeCount'|'bookmarkCount'|'commentCount'|'shareCount'} field
 * @param {number} [delta=1]
 */
ArticleSchema.methods.incrementStat = function (field, delta = 1) {
  return this.constructor.updateOne(
    { _id: this._id },
    { $inc: { [`stats.${field}`]: delta } }
  );
};

// ── Static helpers ────────────────────────────────────────────────────────────

/**
 * Find articles by their FAISS IDs in bulk.
 * Used by the recommendation service after a FAISS search.
 *
 * @param {number[]} faissIds
 * @param {string} [projection] - mongoose projection string
 * @returns {Promise<import('mongoose').Document[]>}
 */
ArticleSchema.statics.findByFaissIds = function (faissIds, projection = '-body') {
  return this.find({ faissId: { $in: faissIds }, isPublished: true, isRemoved: false })
    .select(projection)
    .lean();
};

/**
 * Return un-indexed articles for the ingestion worker to process.
 * @param {number} [batchSize=100]
 */
ArticleSchema.statics.findUnindexed = function (batchSize = 100) {
  return this.find({ isIndexed: false, isPublished: true })
    .select('_id title summary body topics')
    .limit(batchSize)
    .lean();
};

const Article = mongoose.model('Article', ArticleSchema);

module.exports = Article;