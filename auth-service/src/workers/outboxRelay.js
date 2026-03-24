'use strict';

const amqp = require('amqplib');
const Outbox = require('../models/Outbox');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const QUEUE_NAME = 'user_registered';
const RELAY_INTERVAL_MS = parseInt(process.env.RELAY_INTERVAL_MS || '5000', 10);

// Holds the active RabbitMQ confirm-channel so we can reuse it across ticks.
// Set to null whenever the connection drops so the next tick reconnects.
let confirmChannel = null;
let amqpConnection = null;

async function connectRabbitMQ() {
  console.log('[outboxRelay] Connecting to RabbitMQ...');
  amqpConnection = await amqp.connect(RABBITMQ_URL);

  amqpConnection.on('error', (err) => {
    console.error('[outboxRelay] RabbitMQ connection error:', err.message);
    confirmChannel = null;
    amqpConnection = null;
  });

  amqpConnection.on('close', () => {
    console.warn('[outboxRelay] RabbitMQ connection closed. Will reconnect on next tick.');
    confirmChannel = null;
    amqpConnection = null;
  });

  // Use a confirm channel so we know when the broker has persisted each message
  confirmChannel = await amqpConnection.createConfirmChannel();

  await confirmChannel.assertQueue(QUEUE_NAME, { durable: true });

  console.log('[outboxRelay] RabbitMQ confirm-channel ready. Queue:', QUEUE_NAME);
}

async function ensureChannel() {
  if (confirmChannel) return;
  await connectRabbitMQ();
}

async function publishWithConfirm(channel, payload) {
  return new Promise((resolve, reject) => {
    const messageBuffer = Buffer.from(JSON.stringify(payload));
    const ok = channel.sendToQueue(QUEUE_NAME, messageBuffer, {
      persistent: true,    // survives broker restarts
      contentType: 'application/json',
    });

    if (!ok) {
      // Channel write buffer is full — treat as a publish failure
      return reject(new Error('sendToQueue returned false (write buffer full)'));
    }

    // waitForConfirms resolves once the broker ACKs all previously published messages
    channel.waitForConfirms()
      .then(resolve)
      .catch(reject);
  });
}

async function relayPendingEvents() {
  let pendingEvents;

  try {
    pendingEvents = await Outbox.find({ status: 'PENDING' }).sort({ createdAt: 1 });
  } catch (dbErr) {
    console.error('[outboxRelay] Failed to query Outbox collection:', dbErr.message);
    return; // leave events PENDING; retry on next tick
  }

  if (pendingEvents.length === 0) return;

  console.log(`[outboxRelay] Found ${pendingEvents.length} PENDING event(s). Attempting to relay...`);

  for (const event of pendingEvents) {
    try {
      // Lazily (re)connect to RabbitMQ if the channel is gone
      await ensureChannel();

      await publishWithConfirm(confirmChannel, event.payload);

      // ONLY mark as SENT after the broker confirms receipt
      await Outbox.findByIdAndUpdate(event._id, { status: 'SENT' });

      console.log(
        `[outboxRelay] Event ${event._id} (${event.eventType}) published and marked SENT.`
      );
    } catch (publishErr) {
      // Drop the bad channel reference so we reconnect on the next iteration
      confirmChannel = null;
      amqpConnection = null;

      console.error(
        `[outboxRelay] Failed to publish event ${event._id} (${event.eventType}): ${publishErr.message}. ` +
        'Leaving status as PENDING — will retry on next tick.'
      );
      // Continue to the next event — we don't want one failure to block others
    }
  }
}

function startOutboxRelay() {
  console.log(`[outboxRelay] Starting outbox relay. Polling every ${RELAY_INTERVAL_MS}ms.`);

  // Run once immediately so we don't wait a full interval on boot
  relayPendingEvents().catch((err) => {
    console.error('[outboxRelay] Unhandled error on initial relay run:', err.message);
  });

  setInterval(() => {
    relayPendingEvents().catch((err) => {
      // Safety net — should never reach here because relayPendingEvents catches internally,
      // but we log it just in case to ensure the process never crashes.
      console.error('[outboxRelay] Unhandled error during relay tick:', err.message);
    });
  }, RELAY_INTERVAL_MS);
}

module.exports = { startOutboxRelay };
