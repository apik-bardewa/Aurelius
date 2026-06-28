const Bookmark = require('../models/Bookmark');
const Article = require('../models/Article');
const Interaction = require('../models/Interaction');

// POST /api/bookmarks/:articleId
// Add a bookmark. Also records an interaction event (score = 8)
const addBookmark = async (req, res) => {
  try {
    const { articleId } = req.params;

    // Check article exists
    const article = await Article.findById(articleId);
    if (!article) return res.status(404).json({ message: 'Article not found' });

    // Save bookmark (unique index prevents duplicates)
    await Bookmark.create({ userId: req.userId, articleId });

    // Record interaction
    await Interaction.create({
      userId: req.userId,
      articleId,
      type: 'bookmark',
      score: Interaction.SCORES.bookmark,
      topics: article.topics,
    }).catch(() => {}); // ignore duplicate if already recorded via batch

    // Increment article counter
    await Article.findByIdAndUpdate(articleId, { $inc: { bookmarkCount: 1 } });

    res.status(201).json({ message: 'Bookmarked' });
  } catch (err) {
    if (err.code === 11000) return res.json({ message: 'Already bookmarked' });
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/bookmarks/:articleId
// Remove a bookmark
const removeBookmark = async (req, res) => {
  try {
    const deleted = await Bookmark.findOneAndDelete({
      userId: req.userId,
      articleId: req.params.articleId,
    });

    if (!deleted) return res.status(404).json({ message: 'Bookmark not found' });

    // Decrement article counter (don't go below 0)
    await Article.findByIdAndUpdate(req.params.articleId, {
      $inc: { bookmarkCount: -1 },
    });

    res.json({ message: 'Bookmark removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/bookmarks
// Returns all bookmarked articles for the logged-in user
const getBookmarks = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const bookmarks = await Bookmark.find({ userId: req.userId })
      .populate('articleId', '-body')      // fetch article data, skip body
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Bookmark.countDocuments({ userId: req.userId });

    res.json({ bookmarks, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/bookmarks/:articleId/check
// Check if a specific article is bookmarked by the user
const checkBookmark = async (req, res) => {
  try {
    const exists = await Bookmark.findOne({
      userId: req.userId,
      articleId: req.params.articleId,
    });
    res.json({ isBookmarked: !!exists });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { addBookmark, removeBookmark, getBookmarks, checkBookmark };
