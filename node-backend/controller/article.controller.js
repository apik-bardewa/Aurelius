const axios = require('axios');
const Article = require('../models/Article');

// GET /api/articles
// Query: { topic, page, limit }
// Returns paginated list of articles, optionally filtered by topic
const getArticles = async (req, res) => {
  try {
    const { topic, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (topic) filter.topics = topic;

    const articles = await Article.find(filter)
      .select('-body')                      // exclude full body from list view
      .sort({ publishedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Article.countDocuments(filter);

    res.json({ articles, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/articles/:id
// Returns a single article with full body
const getArticle = async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });
    res.json(article);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/articles/search?q=machine+learning
// Semantic search: sends the query to Python FAISS service,
// gets back article IDs, then fetches them from MongoDB
const searchArticles = async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ message: 'Query is required' });

    // Step 1: Ask Python service to embed the query and search FAISS
    // Receives: { query: string, top_k: number }
    // Returns:  { faiss_ids: [12, 45, 203, ...] }
    const faissResponse = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/faiss/search`,
      { query: q, top_k: Number(limit) }
    );

    const faissIds = faissResponse.data.faiss_ids;
    if (!faissIds || faissIds.length === 0) {
      return res.json({ articles: [] });
    }

    // Step 2: Fetch matching articles from MongoDB using faissId field
    const articles = await Article.find({ faissId: { $in: faissIds } })
      .select('-body');

    // Step 3: Re-order articles to match the FAISS ranking order
    const ordered = faissIds
      .map((fid) => articles.find((a) => a.faissId === fid))
      .filter(Boolean);

    res.json({ articles: ordered });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/articles/:id/similar
// Returns articles similar to a given article using FAISS
const getSimilarArticles = async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });

    if (!article.isIndexed || article.faissId === null) {
      return res.status(400).json({ message: 'Article not yet indexed' });
    }

    // Ask Python service to find similar articles by faissId
    // Receives: { faiss_id: number, top_k: number }
    // Returns:  { faiss_ids: [34, 78, 201, ...] }
    const faissResponse = await axios.post(
      `${process.env.PYTHON_SERVICE_URL}/faiss/similar`,
      { faiss_id: article.faissId, top_k: 10 }
    );

    const faissIds = faissResponse.data.faiss_ids;
    const similar = await Article.find({
      faissId: { $in: faissIds },
      _id: { $ne: article._id },           // exclude the article itself
    }).select('-body');

    res.json({ articles: similar });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getArticles, getArticle, searchArticles, getSimilarArticles };
