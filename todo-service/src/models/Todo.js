'use strict';

const mongoose = require('mongoose');

const todoSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      default: 'WELCOME',
    },
    completed: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  }
);

// Unique compound index: one welcome todo per user — acts as a database-level
// idempotency guard in addition to the application-level check.
todoSchema.index({ userId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('Todo', todoSchema);
