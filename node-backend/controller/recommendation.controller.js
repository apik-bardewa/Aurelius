const axios = require('axios');
const User = require('../models/User');
const Article = require('../models/Article');
const UserInterest = require('../models/UserInterest');

// GET /api/recommendations
// Query: { limit }
// Returns personalized articles for the logged-in user
// Flow: get user embedding → call Python FAISS → fetch articles from MongoDB
const getRecommendations = async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // No embedding yet — return topic-based articles as fallback
    if (!user.profileEmbedding || user.profileEmbedding.length === 0) {
      return getTopicBasedRecs(req, res, user, limit);
    }

    // Step 1: Send user embedding to Python FAISS service
    // Receives: { profile_vector: [...384 floats], top_k: number }
    // Returns:  { faiss_ids: [12, 45, 203, ...], scores: [0.94, 0.91, ...] }
    const pyRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/recommend`,
      {
        profile_vector: user.profileEmbedding,
        top_k: Number(limit),
      }
    );

    const faissIds = pyRes.data.faiss_ids || [];
    if (faissIds.length === 0) {
      return res.json({ articles: [], source: 'faiss' });
    }

    // Step 2: Fetch article data from MongoDB
    const articles = await Article.find({ faissId: { $in: faissIds } })
      .select('-body')
      .lean();

    // Step 3: Re-order results to match FAISS similarity ranking
    const ordered = faissIds
      .map((fid) => articles.find((a) => a.faissId === fid))
      .filter(Boolean);

    res.json({ articles: ordered, source: 'faiss' });
  } catch (err) {
    // If Python service is down, fall back to topic-based recommendations
    if (err.code === 'ECONNREFUSED' || err.response?.status >= 500) {
      const user = await User.findById(req.userId);
      return getTopicBasedRecs(req, res, user, req.query.limit || 20);
    }
    res.status(500).json({ message: err.message });
  }
};

// GET /api/recommendations/similar/:articleId
// Find articles similar to a given article using FAISS
const getSimilar = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const article = await Article.findById(req.params.articleId);
    if (!article) return res.status(404).json({ message: 'Article not found' });

    if (!article.isIndexed) {
      return res.status(400).json({ message: 'Article not indexed yet' });
    }

    // Ask Python to find similar articles by this article's faissId
    // Receives: { faiss_id: number, top_k: number }
    // Returns:  { faiss_ids: [34, 78, 201, ...] }
    const pyRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/faiss/similar`,
      { faiss_id: article.faissId, top_k: Number(limit) + 1 }
    );

    const faissIds = (pyRes.data.faiss_ids || []).filter(
      (id) => id !== article.faissId      // remove the source article itself
    );

    const articles = await Article.find({ faissId: { $in: faissIds } })
      .select('-body')
      .lean();

    const ordered = faissIds
      .map((fid) => articles.find((a) => a.faissId === fid))
      .filter(Boolean)
      .slice(0, Number(limit));

    res.json({ articles: ordered });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/recommendations/refresh-embedding
// Manually trigger a profile embedding refresh for the logged-in user
// Useful after the user updates their interests
const refreshEmbedding = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const interest = await UserInterest.findOne({ userId: req.userId });

    if (!interest) {
      return res.status(400).json({ message: 'No interests set. Select topics first.' });
    }

    // Ask Python to rebuild the profile embedding from topic scores + interactions
    // Receives: { user_id: string, topics: [...], topic_scores: {...} }
    // Returns:  { profile_vector: [...384 floats] }
    const pyRes = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/profile/rebuild`,
      {
        user_id: user._id.toString(),
        topics: interest.topics,
        topic_scores: Object.fromEntries(interest.topicScores),
      }
    );

    if (pyRes.data.profile_vector) {
      await User.findByIdAndUpdate(req.userId, {
        profileEmbedding: pyRes.data.profile_vector,
      });
    }

    res.json({ message: 'Embedding refreshed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Helper ────────────────────────────────────────────────────────────────────

// Fallback when FAISS is unavailable or embedding not ready
const getTopicBasedRecs = async (req, res, user, limit) => {
  const topics = user.interests || [];
  const filter = topics.length > 0 ? { topics: { $in: topics } } : {};

  const articles = await Article.find(filter)
    .select('-body')
    .sort({ publishedAt: -1 })
    .limit(Number(limit))
    .lean();

  res.json({ articles, source: 'topic_fallback' });
};

module.exports = { getRecommendations, getSimilar, refreshEmbedding };
