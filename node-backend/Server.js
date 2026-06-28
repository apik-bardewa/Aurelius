require('dotenv').config({ path: './config/.env' });

const express = require('express');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error.middleware');
const { authLimiter, apiLimiter, feedLimiter, batchLimiter } = require('./middleware/rateLimit.middleware');

const app = express();

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json());

// ── Apply rate limits to route groups ────────────────────────────────────────
app.use('/api/auth',                authLimiter);   // strict — login/register
app.use('/api/feed',                feedLimiter);   // relaxed — infinite scroll
app.use('/api/interactions/batch',  batchLimiter);  // batch flush
app.use('/api',                     apiLimiter);    // everything else

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',            require('./routes/auth.routes'));
app.use('/api/users',           require('./routes/user.routes'));
app.use('/api/articles',        require('./routes/article.routes'));
app.use('/api/feed',            require('./routes/feed.routes'));
app.use('/api/interactions',    require('./routes/interaction.routes'));
app.use('/api/bookmarks',       require('./routes/bookmark.routes'));
app.use('/api/comments',        require('./routes/comment.routes'));
app.use('/api/recommendations', require('./routes/recommendation.routes'));
app.use('/api/admin',           require('./routes/admin.routes'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok' }));

// ── Error handling (must be last) ─────────────────────────────────────────────
app.use(notFound);       // catches unknown routes → 404
app.use(errorHandler);   // catches all errors thrown in controllers → formatted JSON

// ── Start server ──────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
  });
});
