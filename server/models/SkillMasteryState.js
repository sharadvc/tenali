const mongoose = require('mongoose');

const SkillMasteryStateSchema = new mongoose.Schema({
  learnerId: { type: String, required: true, index: true },
  skillId: { type: String, required: true },
  pMastery: Number,
  displayedMasteryPercent: Number,
  conceptualGroundingScore: Number,

  // ── Two separate concepts. Do not merge them. ──────────────────────────────
  //
  // currentStage: how far through the Concept Playground stage flow the learner
  // has got. 0 = not started. Bounded by the stage count of the skill.
  //
  // conceptReviewRung: position on the spaced-repetition ladder in
  // lib/spacingLadder.js, i.e. an index into INTERVAL_DAYS [1, 3, 7, 14, 30].
  //
  // These were previously conflated: the client read conceptReviewRung as a
  // stage index while the server wrote it as a ladder rung. See #293.
  currentStage: { type: Number, default: 0 },
  conceptReviewRung: { type: Number, default: 0 },

  // True while the learner is working through a due spaced review. Server-owned:
  // it is what makes a run count as a replay, so the client cannot assert its
  // way up the ladder.
  replayInProgress: { type: Boolean, default: false },

  lastConceptReviewAt: Date,
  nextConceptReviewDue: Date
}, { timestamps: true });

SkillMasteryStateSchema.index({ learnerId: 1, skillId: 1 }, { unique: true });

module.exports = mongoose.model('SkillMasteryState', SkillMasteryStateSchema);
