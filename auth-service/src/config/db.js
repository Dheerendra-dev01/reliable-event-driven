'use strict';

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 3000;

async function connectWithRetry(attempt = 1) {
  try {
    console.log(`[db] Connecting to MongoDB (attempt ${attempt})...`);
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 2000,
    });
    console.log('[db] Connected to MongoDB successfully.');
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      console.error(`[db] Could not connect to MongoDB after ${MAX_RETRIES} attempts. Last error:`, err.message);
      // Do not exit — let the process keep running; the relay worker and routes
      // will fail gracefully until the DB comes back.
      return;
    }
    console.warn(`[db] Connection failed (${err.message}). Retrying in ${RETRY_DELAY_MS}ms...`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    await connectWithRetry(attempt + 1);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('[db] MongoDB disconnected. Mongoose will attempt to reconnect automatically.');
});

mongoose.connection.on('error', (err) => {
  console.error('[db] MongoDB connection error:', err.message);
});

module.exports = { connectWithRetry };
