const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  summary: {
    // Short preview shown on feed cards (~250 chars)
    type: String,
    default: '',
  },
  body: {
    type: String,
    default: '',
  },
  imageUrl: {
    type: String,
    default: null,
  },
  source: {
    type: String,
    default: '',
  },
  author: {
    type: String,
    default: 'Unknown',
  },
  topics: {
    // e.g. ['AI', 'Machine Learning']
    type: [String],
    default: [],
  },
  readTimeMin: {
    type: Number,
    default: 1,
  },
  publishedAt: {
    type: Date,
    default: Date.now,
  },

  // ── FAISS fields ──────────────────────────────────────────────────────────
  faissId: {
    // Integer ID assigned by FAISS when this article's embedding was indexed.
    // Used to map FAISS search results back to this MongoDB document.
    type: Number,
    default: null,
  },
  isIndexed: {
    // False until the ingestion pipeline adds this article to the FAISS index.
    type: Boolean,
    default: false,
  },
  // ─────────────────────────────────────────────────────────────────────────

  likeCount:     { type: Number, default: 0 },
  bookmarkCount: { type: Number, default: 0 },
  commentCount:  { type: Number, default: 0 },
  shareCount:    { type: Number, default: 0 },
}, { timestamps: true });

// Speed up topic-filtered feeds
ArticleSchema.index({ topics: 1 });
// Unique FAISS ID mapping (sparse so null values are allowed)
ArticleSchema.index({ faissId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Article', ArticleSchema);