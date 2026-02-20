const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');

const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

/**
 * POST /api/auth/register
 * Creates a new anonymous user account and returns a JWT token.
 * Body: { user_name, gender, bio?, interests? }
 */
exports.register = async (req, res) => {
  try {
    const { user_name, gender, bio, interests } = req.body;

    if (!user_name || typeof user_name !== 'string' || user_name.trim().length < 2) {
      return res.status(400).json({ message: 'Username must be at least 2 characters.' });
    }
    if (!gender || !['Male', 'Female', 'Unknown'].includes(gender)) {
      return res.status(400).json({ message: 'Gender must be Male, Female, or Unknown.' });
    }
    if (user_name.trim().length > 30) {
      return res.status(400).json({ message: 'Username must not exceed 30 characters.' });
    }

    const existingUser = await User.findOne({ user_name: user_name.trim() });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already taken.' });
    }

    const user = new User({
      user_name: user_name.trim(),
      gender,
      bio: bio ? String(bio).trim().slice(0, 300) : '',
      interests: Array.isArray(interests) ? interests.map((i) => String(i).trim()).slice(0, 20) : [],
    });

    await user.save();
    const token = generateToken(user._id.toString());

    logger.info('New user registered', { userId: user._id, username: user.user_name });

    return res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: {
        _id: user._id,
        user_name: user.user_name,
        gender: user.gender,
        bio: user.bio,
        interests: user.interests,
      },
    });
  } catch (err) {
    logger.error('Error in register', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

/**
 * POST /api/auth/token/refresh
 * Allows a client holding a valid token to get a fresh one before expiry.
 * Requires: Authorization: Bearer <token>
 */
exports.refreshToken = async (req, res) => {
  try {
    // req.userId is set by authenticate middleware
    const user = await User.findById(req.userId).select('_id user_name gender bio interests');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const token = generateToken(user._id.toString());
    logger.info('Token refreshed', { userId: user._id });

    return res.status(200).json({
      message: 'Token refreshed.',
      token,
      user: {
        _id: user._id,
        user_name: user.user_name,
        gender: user.gender,
        bio: user.bio,
        interests: user.interests,
      },
    });
  } catch (err) {
    logger.error('Error in refreshToken', { error: err.message });
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
