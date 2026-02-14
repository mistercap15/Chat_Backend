require('dotenv').config();
const { connectDB } = require('../config/db');
const Interest = require('../models/Interest');

const interests = [
  { name: 'Gaming' },
  { name: 'Movies' },
  { name: 'Travel' },
  { name: 'Music' },
  { name: 'Fitness' },
];

const seedInterests = async () => {
  try {
    await connectDB();
    await Interest.deleteMany({});
    await Interest.insertMany(interests);
    console.log('Interests seeded ✅');
    process.exit(0);
  } catch (error) {
    console.error('Interest seeding failed:', error.message);
    process.exit(1);
  }
};

seedInterests();
