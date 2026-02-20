const logger = require('../utils/logger');

const authenticateAdmin = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];

  if (!adminKey) {
    return res.status(401).json({ message: 'Admin authentication required.' });
  }

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    logger.warn('Invalid admin key attempt', { ip: req.ip });
    return res.status(403).json({ message: 'Invalid admin credentials.' });
  }

  next();
};

module.exports = { authenticateAdmin };
