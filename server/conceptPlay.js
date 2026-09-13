'use strict';

const express = require('express');
const mongoose = require('mongoose');
const ConceptPlayAttempt = require('./models/ConceptPlayAttempt');
const auth = require('./auth');

// Telemetry accepts any playground template's skill id, not just the two skills
// that have a staged flow (EquationSandbox uses 'sandbox_trig', for example).
// This is a log, not a mastery write, so the strict CONCEPT_SKILLS allowlist in
// lib/conceptSkills.js guards the session routes instead.
const SKILL_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

const router = express.Router();

// Log a Concept Playground struggle attempt.
//
// Telemetry only. Mastery is updated through lil/processAttempt from
// conceptSession.js; nothing here computes or stores a mastery number.
router.post('/attempt', auth.requireAuth, async (req, res) => {
  try {
    const {
      skillId,
      classLevel,
      templateUsed,
      proximityScore,
      attempts,
      selfExplanationText,
      match
    } = req.body;

    // Identity comes from the token, never from the body.
    const learnerId = req.user.id;

    if (typeof skillId !== 'string' || !SKILL_ID_PATTERN.test(skillId)) {
      return res.status(400).json({ success: false, error: 'invalid skillId' });
    }
    if (!templateUsed || typeof templateUsed !== 'string') {
      return res.status(400).json({ success: false, error: 'templateUsed is required' });
    }
    if (typeof proximityScore !== 'number' || Number.isNaN(proximityScore)) {
      return res.status(400).json({ success: false, error: 'proximityScore must be a number' });
    }
    if (!Number.isInteger(attempts) || attempts < 0) {
      return res.status(400).json({ success: false, error: 'attempts must be a non-negative integer' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, error: 'Mongo not connected' });
    }

    const attempt = new ConceptPlayAttempt({
      learnerId,
      skillId,
      classLevel,
      templateUsed,
      proximityScore,
      attempts,
      selfExplanationText,
      match
    });
    await attempt.save();

    res.status(201).json({ success: true, attemptId: attempt._id });
  } catch (error) {
    console.error('[ConceptPlay] Error saving attempt:', error.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
