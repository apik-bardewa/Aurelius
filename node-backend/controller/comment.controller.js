const Comment = require('../models/Comment');
const Article = require('../models/Article');
const Interaction = require('../models/Interaction');

// POST /api/comments/:articleId
// Body: { body, parentId? }
// Add a comment to an article
const addComment = async (req, res) => {
  try {
    const { body, parentId = null } = req.body;
    const { articleId } = req.params;

    if (!body || body.trim() === '') {
      return res.status(400).json({ message: 'Comment body is required' });
    }

    // If it's a reply, check the parent exists
    if (parentId) {
      const parent = await Comment.findById(parentId);
      if (!parent) return res.status(404).json({ message: 'Parent comment not found' });
    }

    const comment = await Comment.create({
      articleId,
      userId: req.userId,
      body: body.trim(),
      parentId,
    });

    // Increment article comment count
    await Article.findByIdAndUpdate(articleId, { $inc: { commentCount: 1 } });

    // Record interaction
    const article = await Article.findById(articleId).select('topics');
    await Interaction.create({
      userId: req.userId,
      articleId,
      type: 'comment',
      score: Interaction.SCORES.comment,
      topics: article ? article.topics : [],
    }).catch(() => {});

    // Populate user info before returning
    await comment.populate('userId', 'name');

    res.status(201).json(comment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/comments/:articleId
// Returns all comments for an article (top-level with replies nested under them)
const getComments = async (req, res) => {
  try {
    const { articleId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    // Fetch top-level comments
    const topLevel = await Comment.find({ articleId, parentId: null })
      .populate('userId', 'name')
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    // Fetch replies for those comments
    const parentIds = topLevel.map((c) => c._id);
    const replies = await Comment.find({ parentId: { $in: parentIds } })
      .populate('userId', 'name')
      .sort({ createdAt: 1 })
      .lean();

    // Attach replies to their parent comment
    const replyMap = {};
    for (const reply of replies) {
      const key = reply.parentId.toString();
      if (!replyMap[key]) replyMap[key] = [];
      replyMap[key].push(reply);
    }

    const threaded = topLevel.map((c) => ({
      ...c,
      replies: replyMap[c._id.toString()] || [],
    }));

    const total = await Comment.countDocuments({ articleId, parentId: null });

    res.json({ comments: threaded, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/comments/:commentId
// Only the comment author can delete their comment
const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    if (comment.userId.toString() !== req.userId) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    await comment.deleteOne();

    // Decrement article comment count
    await Article.findByIdAndUpdate(comment.articleId, {
      $inc: { commentCount: -1 },
    });

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/comments/:commentId/like
// Toggle like on a comment
const likeComment = async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.commentId,
      { $inc: { likeCount: 1 } },
      { new: true }
    );

    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    res.json({ likeCount: comment.likeCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { addComment, getComments, deleteComment, likeComment };
