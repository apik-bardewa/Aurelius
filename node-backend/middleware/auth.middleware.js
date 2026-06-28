const jwt = require('jsonwebtoken');

// Attach to any route that requires the user to be logged in.
// Reads the Bearer token from the Authorization header,
// verifies it, and puts the userId on req so controllers can use it.

// Usage in routes:
//   router.get('/profile', protect, getProfile);

const protect = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // Check header exists and starts with "Bearer "
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token. Please log in.' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token with the secret key from .env
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach userId to request so controllers can use req.userId
    req.userId = decoded.userId;

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

module.exports = { protect };
