require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Interest = require('../models/Interest');

const interests = [
  { name: 'Gaming' },
  { name: 'Movies' },
  { name: 'Travel' },
  { name: 'Music' },
  { name: 'Fitness' },
];

const seedInterests = async () => {
  await connectDB();
  await Interest.deleteMany();
  await Interest.insertMany(interests);
  console.log('Interests Seeded ✅');
  process.exit();
};

seedInterests();
