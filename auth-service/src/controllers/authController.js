'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Outbox = require('../models/Outbox');

const SALT_ROUNDS = 10;

async function register(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: 'Both email and password are required.',
    });
  }

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Hash password before persisting
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // a) Create the User document inside the transaction
    const [user] = await User.create(
      [
        {
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          createdAt: new Date(),
        },
      ],
      { session }
    );

    // b) Create the Outbox document atomically in the same transaction
    await Outbox.create(
      [
        {
          eventType: 'USER_REGISTERED',
          payload: {
            userId: user._id.toString(),
            email: user.email,
          },
          status: 'PENDING',
          createdAt: new Date(),
        },
      ],
      { session }
    );

    // Commit only when both writes succeed
    await session.commitTransaction();

    console.log(`[authController] User registered successfully: ${user.email} (id: ${user._id})`);

    return res.status(201).json({
      message: 'User registered',
      userId: user._id,
    });
  } catch (err) {
    // Roll back both writes atomically on any failure
    await session.abortTransaction().catch((abortErr) => {
      console.error('[authController] Failed to abort transaction:', abortErr.message);
    });

    if (err.code === 11000) {
      // Duplicate key — email already registered
      console.warn(`[authController] Duplicate registration attempt for email: ${req.body.email}`);
      return res.status(409).json({ message: 'Email is already registered.' });
    }

    console.error('[authController] Registration error:', err.message);
    return res.status(500).json({ message: 'Internal server error during registration.' });
  } finally {
    session.endSession();
  }
}

module.exports = { register };
