'use strict';

const express = require('express');
const { register } = require('../controllers/authController');

const router = express.Router();

// POST /register
// Body: { email: string, password: string }
router.post('/register', register);

module.exports = router;
