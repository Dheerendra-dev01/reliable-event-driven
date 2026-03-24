'use strict';

require('dotenv').config();

const { connectWithRetry } = require('./config/db');
const { startConsumer } = require('./consumers/userRegistered');

async function main() {
  console.log('[todo-service] Starting...');

  // 1. Connect to MongoDB (with retry loop)
  await connectWithRetry();

  // 2. Start the RabbitMQ consumer (also has its own retry loop)
  await startConsumer();
}

main().catch((err) => {
  console.error('[todo-service] Fatal startup error:', err.message);
  // Do not call process.exit — let Docker restart the container
});
