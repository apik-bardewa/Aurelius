const axios = require('axios');
const User = require('../models/User');
const Article = require('../models/Article');
const FeedSession = require('../models/FeedSession');

// GET /api/feed
// Query: { cursor, limit, sessionId }
// Returns personalized articles based on user's profile embedding via FAISS
const getFeed = async (req, res) => {
  try {
    const { cursor = 0, limit = 20, sessionId } = req.query;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // If the user has no profile embedding yet, fall back to topic filter
    if (!user.profileEmbedding || user.profileEmbedding.length === 0) {
      return getTopicFallbackFeed(req, res, user);
    }

    // Step 1: Ask Python recommendation service for article IDs
    // Receives: { profile_vector: [...384 floats], top_k: number, seen_ids: [...] }
    // Returns:  { faiss_ids: [12, 45, 203, ...] }
    const seenIds = user.seenArticleIds || [];

    const recResponse = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/recommend`,
      {
        profile_vector: user.profileEmbedding,
        top_k: Number(limit) + 10,        // fetch a few extra to fill gaps
        seen_faiss_ids: seenIds,
      }
    );

    const faissIds = recResponse.data.faiss_ids || [];

    // Step 2: Fetch article details from MongoDB
    const articles = await Article.find({ faissId: { $in: faissIds } })
      .select('-body')
      .lean();

    // Step 3: Re-order to match FAISS ranking
    const ordered = faissIds
      .map((fid) => articles.find((a) => a.faissId === fid))
      .filter(Boolean)
      .slice(0, Number(limit));

    // Step 4: Update FeedSession if sessionId provided
    if (sessionId) {
      await FeedSession.findOneAndUpdate(
        { sessionId },
        {
          $setOnInsert: { userId: req.userId, sessionId },
          $set: { lastCursor: Number(cursor) + ordered.length },
          $inc: { articlesViewed: ordered.length },
          isActive: true,
        },
        { upsert: true }
      );
    }

    res.json({
      articles: ordered,
      nextCursor: Number(cursor) + ordered.length,
      hasMore: ordered.length === Number(limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Fallback: return articles matching user's selected topic interests
// Used when profileEmbedding is not yet generated
const getTopicFallbackFeed = async (req, res, user) => {
  const { cursor = 0, limit = 20 } = req.query;
  const topics = user.interests || [];

  const filter = topics.length > 0 ? { topics: { $in: topics } } : {};

  const articles = await Article.find(filter)
    .select('-body')
    .sort({ publishedAt: -1 })
    .skip(Number(cursor))
    .limit(Number(limit))
    .lean();

  res.json({
    articles,
    nextCursor: Number(cursor) + articles.length,
    hasMore: articles.length === Number(limit),
    fallback: true,  // tells the client embedding is not ready yet
  });
};

// GET /api/feed/trending
// Query: { limit }
// Returns articles with the highest like + share + bookmark counts
const getTrending = async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const articles = await Article.find()
      .select('-body')
      .sort({ likeCount: -1, shareCount: -1, bookmarkCount: -1 })
      .limit(Number(limit))
      .lean();

    res.json({ articles });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/feed/topic/:topic
// Returns latest articles for a specific topic
const getTopicFeed = async (req, res) => {
  try {
    const { topic } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const articles = await Article.find({ topics: topic })
      .select('-body')
      .sort({ publishedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    res.json({ articles, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getFeed, getTrending, getTopicFeed };
