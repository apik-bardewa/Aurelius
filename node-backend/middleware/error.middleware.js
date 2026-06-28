// Global error handler — must be registered LAST in server.js with app.use()
// Express identifies it as an error handler because it takes 4 arguments (err, req, res, next).

// Usage in server.js (add after all routes):
//   app.use(errorHandler);

const errorHandler = (err, req, res, next) => {
  // Log the error for debugging
  console.error(`[ERROR] ${req.method} ${req.originalUrl} →`, err.message);

  // Default to 500 if no status code was set
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong.';

  // MongoDB duplicate key error (e.g. email already exists)
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `${field} already exists.`;
  }

  // MongoDB validation error (e.g. required field missing)
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ');
  }

  // MongoDB invalid ObjectId (e.g. /articles/not-a-valid-id)
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ID format.`;
  }

  // JWT errors — should normally be caught in auth middleware,
  // but handle here as a safety net
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token.';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired. Please log in again.';
  }

  res.status(statusCode).json({ message });
};

// 404 handler — for routes that don't exist
// Usage in server.js (add before errorHandler):
//   app.use(notFound);
//   app.use(errorHandler);

const notFound = (req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found.` });
};

module.exports = { errorHandler, notFound };
