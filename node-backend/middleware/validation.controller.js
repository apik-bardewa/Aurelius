// Simple request body validators.
// Each function checks required fields and returns 400 with a clear message
// if something is missing or invalid — before the request reaches the controller.

// Usage in routes:
//   router.post('/register', validateRegister, register);

// ── Auth ──────────────────────────────────────────────────────────────────────

const validateRegister = (req, res, next) => {
  const { name, email, password } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ message: 'Name is required.' });
  }
  if (!email || email.trim() === '') {
    return res.status(400).json({ message: 'Email is required.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ message: 'Invalid email format.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  next();
};

const validateLogin = (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  next();
};

// ── User interests ────────────────────────────────────────────────────────────

const VALID_TOPICS = [
  'AI', 'Machine Learning', 'Finance', 'Sports', 'Health',
  'Programming', 'Science', 'Politics', 'Business', 'Design',
  'Travel', 'Food', 'Technology', 'Environment', 'Entertainment', 'Education',
];

const validateInterests = (req, res, next) => {
  const { topics } = req.body;

  if (!topics || !Array.isArray(topics) || topics.length === 0) {
    return res.status(400).json({ message: 'Select at least one topic.' });
  }

  const invalid = topics.filter((t) => !VALID_TOPICS.includes(t));
  if (invalid.length > 0) {
    return res.status(400).json({
      message: `Invalid topics: ${invalid.join(', ')}`,
      validTopics: VALID_TOPICS,
    });
  }

  next();
};

// ── Comments ──────────────────────────────────────────────────────────────────

const validateComment = (req, res, next) => {
  const { body } = req.body;

  if (!body || body.trim() === '') {
    return res.status(400).json({ message: 'Comment body is required.' });
  }
  if (body.length > 1000) {
    return res.status(400).json({ message: 'Comment must be under 1000 characters.' });
  }

  next();
};

// ── Interaction batch ─────────────────────────────────────────────────────────

const VALID_TYPES = ['view', 'read_30', 'read_60', 'like', 'bookmark', 'comment', 'share'];

const validateBatch = (req, res, next) => {
  const { events } = req.body;

  if (!events || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ message: 'events array is required.' });
  }
  if (events.length > 50) {
    return res.status(400).json({ message: 'Maximum 50 events per batch.' });
  }

  for (const e of events) {
    if (!e.articleId) {
      return res.status(400).json({ message: 'Each event needs an articleId.' });
    }
    if (!VALID_TYPES.includes(e.type)) {
      return res.status(400).json({
        message: `Invalid event type '${e.type}'.`,
        validTypes: VALID_TYPES,
      });
    }
  }

  next();
};

// ── Search ────────────────────────────────────────────────────────────────────

const validateSearch = (req, res, next) => {
  const { q } = req.query;

  if (!q || q.trim() === '') {
    return res.status(400).json({ message: 'Search query (q) is required.' });
  }
  if (q.length > 200) {
    return res.status(400).json({ message: 'Search query too long (max 200 chars).' });
  }

  next();
};

module.exports = {
  validateRegister,
  validateLogin,
  validateInterests,
  validateComment,
  validateBatch,
  validateSearch,
};
