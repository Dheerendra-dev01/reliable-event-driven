'use strict';

require('dotenv').config();

const express = require('express');
const { connectWithRetry } = require('./config/db');
const authRoutes = require('./routes/auth');
const { startOutboxRelay } = require('./workers/outboxRelay');

const PORT = process.env.PORT || 3001;

async function main() {
  // 1. Connect to MongoDB (with retry loop)
  await connectWithRetry();

  // 2. Create Express app
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'auth-service' });
  });

  // Mount auth routes under /
  app.use('/', authRoutes);

  // Generic 404 handler
  app.use((req, res) => {
    res.status(404).json({ message: 'Route not found.' });
  });

  // Central error handler
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[auth-service] Unhandled error:', err.message);
    res.status(500).json({ message: 'An unexpected error occurred.' });
  });

  // 3. Start HTTP server
  app.listen(PORT, () => {
    console.log(`[auth-service] HTTP server listening on port ${PORT}`);
  });

  // 4. Start the outbox relay background worker
  startOutboxRelay();
}

main().catch((err) => {
  console.error('[auth-service] Fatal startup error:', err.message);
  // Do not call process.exit — let Docker restart the container
});
