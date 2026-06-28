const Article = require('../models/Article');
const User = require('../models/User');
const Interaction = require('../models/Interaction');
const Comment = require('../models/Comment');

// All routes here require isAdmin middleware (checked in routes file)

// GET /api/admin/stats
// Returns basic platform stats
const getStats = async (req, res) => {
  try {
    const [totalArticles, totalUsers, totalInteractions, indexedArticles] =
      await Promise.all([
        Article.countDocuments(),
        User.countDocuments(),
        Interaction.countDocuments(),
        Article.countDocuments({ isIndexed: true }),
      ]);

    res.json({
      totalArticles,
      totalUsers,
      totalInteractions,
      indexedArticles,
      unindexedArticles: totalArticles - indexedArticles,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/admin/articles
// Body: { title, summary, body, imageUrl, source, author, topics, publishedAt, readTimeMin }
// Manually create an article (ingestion pipeline handles bulk creation)
const createArticle = async (req, res) => {
  try {
    const article = await Article.create(req.body);
    res.status(201).json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/articles/:id
// Update any article field
const updateArticle = async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!article) return res.status(404).json({ message: 'Article not found' });
    res.json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/articles/:id
// Delete an article and its comments
const deleteArticle = async (req, res) => {
  try {
    const article = await Article.findByIdAndDelete(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });

    // Clean up associated comments
    await Comment.deleteMany({ articleId: req.params.id });

    res.json({ message: 'Article deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/articles/unindexed
// Returns articles not yet added to the FAISS index
// Used by the ingestion worker to know what needs to be processed
const getUnindexedArticles = async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const articles = await Article.find({ isIndexed: false })
      .select('_id title summary topics')
      .limit(Number(limit));

    res.json({ articles, count: articles.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/articles/:id/mark-indexed
// Body: { faissId }
// Called by the ingestion worker after adding the article to FAISS
const markArticleIndexed = async (req, res) => {
  try {
    const { faissId } = req.body;
    if (faissId === undefined) {
      return res.status(400).json({ message: 'faissId is required' });
    }

    const article = await Article.findByIdAndUpdate(
      req.params.id,
      { faissId, isIndexed: true },
      { new: true }
    );

    if (!article) return res.status(404).json({ message: 'Article not found' });

    res.json({ message: 'Marked as indexed', article });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/admin/users
// Returns list of users (email, name, interests, createdAt)
const getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;

    const users = await User.find()
      .select('-password -profileEmbedding')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await User.countDocuments();

    res.json({ users, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/users/:id
// Delete a user and all their data
const deleteUser = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await Interaction.deleteMany({ userId: req.params.id });
    await Comment.deleteMany({ userId: req.params.id });

    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getStats,
  createArticle,
  updateArticle,
  deleteArticle,
  getUnindexedArticles,
  markArticleIndexed,
  getUsers,
  deleteUser,
};
