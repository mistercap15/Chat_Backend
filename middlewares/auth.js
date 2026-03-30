const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    logger.warn('Invalid JWT token', { error: err.message });
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ message: 'Invalid token.' });
  }
};

/**
 * Verifies that the authenticated user is operating on their own resource.
 * Compares req.userId (from JWT) with a userId from body/params.
 */
const authorizeOwn = (userIdSource = 'body') => (req, res, next) => {
  const userId = userIdSource === 'params' ? req.params.userId : req.body.userId;
  if (!userId || userId !== req.userId) {
    return res.status(403).json({ message: 'Forbidden: you can only modify your own data.' });
  }
  next();
};

module.exports = { authenticate, authorizeOwn };
