const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
  articleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Article',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  body: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000,
  },
  parentId: {
    // null = top-level comment, ObjectId = reply to another comment
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
  },
  likeCount: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

// Fetch all comments for an article ordered by time
CommentSchema.index({ articleId: 1, createdAt: 1 });

module.exports = mongoose.model('Comment', CommentSchema);