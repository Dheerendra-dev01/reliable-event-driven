'use strict';

const amqp = require('amqplib');
const Todo = require('../models/Todo');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const QUEUE_NAME = 'user_registered';
const RECONNECT_DELAY_MS = 5000;

async function handleMessage(channel, msg) {
  if (!msg) {
    // Consumer was cancelled by the broker (e.g. queue deleted)
    console.warn('[userRegistered] Consumer cancelled by broker.');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch (parseErr) {
    console.error('[userRegistered] Failed to parse message JSON:', parseErr.message);
    // Malformed message — ack it to remove it from the queue permanently
    // (nacking a bad message would just requeue it forever)
    channel.ack(msg);
    return;
  }

  const { userId, email } = payload;

  if (!userId || !email) {
    console.error('[userRegistered] Message missing userId or email fields. Discarding.', payload);
    channel.ack(msg);
    return;
  }

  try {
    // ── Idempotency check (application layer) ────────────────────────────────
    // The compound unique index on { userId, type } in the Todo schema provides
    // a second safety net at the database layer.
    const existing = await Todo.findOne({
      userId,
      title: 'Welcome to the App',
      type: 'WELCOME',
    });

    if (existing) {
      console.log(
        `[userRegistered] Welcome todo already exists for userId=${userId}. Skipping creation. (idempotent)`
      );
      channel.ack(msg);
      return;
    }

    // ── Create the welcome todo ──────────────────────────────────────────────
    await Todo.create({
      userId,
      title: 'Welcome to the App',
      type: 'WELCOME',
      completed: false,
      createdAt: new Date(),
    });

    console.log(`[userRegistered] Created welcome todo for userId=${userId} (${email}).`);

    // Acknowledge only after successful DB write
    channel.ack(msg);
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key from the DB index — another instance already created the todo
      console.warn(
        `[userRegistered] Duplicate key on todo creation for userId=${userId}. Idempotent ack.`
      );
      channel.ack(msg);
      return;
    }

    console.error(`[userRegistered] Error processing message for userId=${userId}:`, err.message);
    // Nack with requeue: true so the message is re-delivered and we retry
    channel.nack(msg, false, true);
  }
}

async function startConsumer() {
  try {
    console.log('[userRegistered] Connecting to RabbitMQ...');
    const connection = await amqp.connect(RABBITMQ_URL);

    connection.on('error', (err) => {
      console.error('[userRegistered] RabbitMQ connection error:', err.message);
    });

    connection.on('close', () => {
      console.warn(
        `[userRegistered] RabbitMQ connection closed. Reconnecting in ${RECONNECT_DELAY_MS}ms...`
      );
      setTimeout(startConsumer, RECONNECT_DELAY_MS);
    });

    const channel = await connection.createChannel();

    // Only fetch one message at a time — prevents overwhelming the service
    channel.prefetch(1);

    await channel.assertQueue(QUEUE_NAME, { durable: true });

    console.log(`[userRegistered] Waiting for messages on queue: ${QUEUE_NAME}`);

    // noAck: false → manual acknowledgement required
    channel.consume(QUEUE_NAME, (msg) => handleMessage(channel, msg), { noAck: false });
  } catch (err) {
    console.error(
      `[userRegistered] Failed to start consumer: ${err.message}. ` +
      `Retrying in ${RECONNECT_DELAY_MS}ms...`
    );
    // Do not call process.exit — retry indefinitely
    setTimeout(startConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startConsumer };
