require('dotenv').config();
const { connectDB } = require('../config/db');
const Interest = require('../models/Interest');

const interests = [
  { name: 'Gaming', category: 'Entertainment' },
  { name: 'Movies', category: 'Entertainment' },
  { name: 'Music', category: 'Entertainment' },
  { name: 'Travel', category: 'Lifestyle' },
  { name: 'Fitness', category: 'Lifestyle' },
  { name: 'Cooking', category: 'Lifestyle' },
  { name: 'Reading', category: 'Education' },
  { name: 'Technology', category: 'Education' },
  { name: 'Art', category: 'Creative' },
  { name: 'Photography', category: 'Creative' },
  { name: 'Sports', category: 'Entertainment' },
  { name: 'Anime', category: 'Entertainment' },
];

const seedInterests = async () => {
  await connectDB();

  await Interest.deleteMany({});
  await Interest.insertMany(interests);

  console.log(`Seeded ${interests.length} interests successfully.`);
  process.exit(0);
};

seedInterests().catch((err) => {
  console.error('Seeder error:', err.message);
  process.exit(1);
});
