const rateLimit = require('express-rate-limit');

// Requires: npm install express-rate-limit

// ── Auth routes (strictest) ───────────────────────────────────────────────────
// Prevents brute-force login and spam registrations.
// Allow 10 requests per 15 minutes per IP.

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,    // send RateLimit-* headers in response
  legacyHeaders: false,
});

// ── General API routes ────────────────────────────────────────────────────────
// Reasonable limit for normal usage.
// Allow 100 requests per minute per IP.

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 100,
  message: { message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Feed / recommendation routes ──────────────────────────────────────────────
// Feed pages can be fetched frequently during infinite scroll,
// so give a slightly higher limit.
// Allow 200 requests per minute per IP.

const feedLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 200,
  message: { message: 'Too many feed requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Interaction batch ─────────────────────────────────────────────────────────
// Batch is sent at most every 5 minutes by the client,
// but allow 30 per minute to handle retries.

const batchLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 30,
  message: { message: 'Too many batch requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, apiLimiter, feedLimiter, batchLimiter };
