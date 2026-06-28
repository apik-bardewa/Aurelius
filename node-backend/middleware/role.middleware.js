const User = require('../models/User');

// Check that the logged-in user has a specific role.
// Must always be used AFTER the protect middleware
// because it needs req.userId to be set first.

// Usage in routes:
//   router.delete('/users/:id', protect, isAdmin, deleteUser);

const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).select('role');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required.' });
    }

    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Generic role checker — pass any role string
// Usage: router.get('/dashboard', protect, checkRole('editor'), handler);
const checkRole = (role) => async (req, res, next) => {
  try {
    const user = await User.findById(req.userId).select('role');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.role !== role) {
      return res.status(403).json({ message: `Role '${role}' required.` });
    }

    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { isAdmin, checkRole };
