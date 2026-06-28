const axios = require('axios');
const Interaction = require('../models/Interaction');
const UserInterest = require('../models/UserInterest');
const Article = require('../models/Article');
const InterestHistory = require('../models/InterestHistory');

const { SCORES } = Interaction;

// POST /api/interactions/batch
// Body: { sessionId, events: [{ articleId, type, topics, readTimeMs }] }
// Called by the client every 20 articles, every 5 minutes, or on page leave
const batchInteractions = async (req, res) => {
  try {
    const { sessionId, events } = req.body;
    if (!events || events.length === 0) {
      return res.status(400).json({ message: 'No events provided' });
    }

    // Step 1: Build interaction docs, deriving score from type on the server
    const docs = events
      .filter((e) => SCORES[e.type] !== undefined)  // ignore unknown types
      .map((e) => ({
        userId: req.userId,
        articleId: e.articleId,
        type: e.type,
        score: SCORES[e.type],                      // always use server score
        topics: e.topics || [],
        readTimeMs: e.readTimeMs || 0,
        sessionId: sessionId || null,
      }));

    // Step 2: Insert, ignoring duplicates (same user+article+type+session)
    let inserted = 0;
    for (const doc of docs) {
      try {
        await Interaction.create(doc);
        inserted++;
      } catch (e) {
        if (e.code !== 11000) throw e; // 11000 = duplicate key, skip it
      }
    }

    // Step 3: Update topicScores in UserInterest
    await updateTopicScores(req.userId, docs);

    // Step 4: Ask Python service to update the user's profile embedding
    // This is fire-and-forget — we don't block the response on it
    updateProfileEmbedding(req.userId).catch((e) =>
      console.warn('Profile embedding update failed:', e.message)
    );

    // Step 5: Update article like/share/bookmark counters
    await updateArticleCounts(docs);

    res.json({ processed: inserted, total: events.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/interactions/like/:articleId
// Immediate like action (also handled via batch but available as direct endpoint)
const likeArticle = async (req, res) => {
  try {
    await Interaction.create({
      userId: req.userId,
      articleId: req.params.articleId,
      type: 'like',
      score: SCORES.like,
    });

    await Article.findByIdAndUpdate(req.params.articleId, {
      $inc: { likeCount: 1 },
    });

    res.json({ message: 'Liked' });
  } catch (err) {
    if (err.code === 11000) return res.json({ message: 'Already liked' });
    res.status(500).json({ message: err.message });
  }
};

// POST /api/interactions/share/:articleId
const shareArticle = async (req, res) => {
  try {
    await Interaction.create({
      userId: req.userId,
      articleId: req.params.articleId,
      type: 'share',
      score: SCORES.share,
    });

    await Article.findByIdAndUpdate(req.params.articleId, {
      $inc: { shareCount: 1 },
    });

    res.json({ message: 'Shared' });
  } catch (err) {
    if (err.code === 11000) return res.json({ message: 'Already shared' });
    res.status(500).json({ message: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Apply exponential decay and add new interaction scores to each topic
const updateTopicScores = async (userId, docs) => {
  const interest = await UserInterest.findOne({ userId });
  if (!interest) return;

  const scoresBefore = Object.fromEntries(interest.topicScores);

  // Decay all existing scores slightly so recent interactions matter more
  for (const [topic, score] of interest.topicScores.entries()) {
    interest.topicScores.set(topic, score * 0.995);
  }

  // Add score for each topic in each interaction
  for (const doc of docs) {
    for (const topic of doc.topics) {
      const current = interest.topicScores.get(topic) || 0;
      interest.topicScores.set(topic, current + doc.score);
    }
  }

  await interest.save();

  // Log the change
  await InterestHistory.create({
    userId,
    trigger: 'interaction_batch',
    topicsBefore: interest.topics,
    topicsAfter: interest.topics,
    topicScoresBefore: scoresBefore,
    topicScoresAfter: Object.fromEntries(interest.topicScores),
  });
};

// Fire-and-forget: ask Python service to recompute user profile embedding
const updateProfileEmbedding = async (userId) => {
  const response = await axios.post(
    `${process.env.PYTHON_SERVICE_URL}/profile/update`,
    { user_id: userId.toString() }
  );

  if (response.data.profile_vector) {
    const User = require('../models/User');
    await User.findByIdAndUpdate(userId, {
      profileEmbedding: response.data.profile_vector,
    });
  }
};

// Increment article counter for like/bookmark/share events
const updateArticleCounts = async (docs) => {
  const fieldMap = {
    like:     'likeCount',
    bookmark: 'bookmarkCount',
    share:    'shareCount',
    comment:  'commentCount',
  };

  for (const doc of docs) {
    const field = fieldMap[doc.type];
    if (field) {
      await Article.findByIdAndUpdate(doc.articleId, { $inc: { [field]: 1 } });
    }
  }
};

module.exports = { batchInteractions, likeArticle, shareArticle };
