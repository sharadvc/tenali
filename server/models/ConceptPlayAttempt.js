const mongoose = require('mongoose');

// Telemetry for a single Concept Playground struggle attempt.
//
// This is research data, not mastery. Mastery is computed server-side through
// lil/processAttempt -> masteryEngine (see the Concept Playgrounds section of
// the README). Nothing here feeds a mastery number.
//
// Extracted from an inline schema in conceptPlay.js so it matches the rest of
// server/models/.
const ConceptPlayAttemptSchema = new mongoose.Schema({
  // Canonical learner identity: req.user.id, i.e. the JWT `sub`, which is
  // User._id as a string. Never taken from the request body.
  learnerId: { type: String, required: true, index: true },
  skillId: { type: String, required: true },
  classLevel: { type: String },
  templateUsed: { type: String, required: true },
  proximityScore: { type: Number, required: true },
  attempts: { type: Number, required: true },
  selfExplanationText: { type: String },
  match: { type: Boolean },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ConceptPlayAttempt', ConceptPlayAttemptSchema);
