'use strict';

const express = require('express');
const mongoose = require('mongoose');
const QformulaConceptSession = require('./models/QformulaConceptSession');
const SimulConceptSession = require('./models/SimulConceptSession');
const SkillMasteryState = require('./models/SkillMasteryState');
const { nextInterval, INTERVAL_DAYS } = require('./lib/spacingLadder');
const { isConceptSkill, stageCountFor } = require('./lib/conceptSkills');
const auth = require('./auth');
const lilProcess = require('./lil/processAttempt');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Canonical learner identity is req.user.id: the JWT `sub`, which is
// User._id.toString() when Mongo is up. It is never read from the URL or body.
function learnerIdOf(req) {
  return req.user && req.user.id;
}

function sessionModelFor(skillId) {
  return skillId === 'simul' ? SimulConceptSession : QformulaConceptSession;
}

function mongoReady() {
  return mongoose.connection.readyState === 1;
}

// The in-memory auth fallback signs `sub` as the username rather than an
// ObjectId (see signToken in auth.js). ConceptMastery.userId is an ObjectId
// ref, so pushing a username through processAttempt would throw a CastError.
function isObjectIdLike(id) {
  return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
}

// Validate :skillId once, consistently, before any DB work.
function requireConceptSkill(req, res, next) {
  if (!isConceptSkill(req.params.skillId)) {
    return res.status(404).json({ success: false, error: 'unknown concept skill' });
  }
  next();
}

function serialiseState(state, skillId, extra = {}) {
  const stageCount = stageCountFor(skillId);
  const isDue = !!(state && state.nextConceptReviewDue && new Date() >= state.nextConceptReviewDue);
  return {
    success: true,
    skillId,
    stageCount,
    currentStage: state ? (state.currentStage || 0) : 0,
    // showRoteBanner: no concept grounding recorded, or a weak one.
    showRoteBanner: !state || state.conceptualGroundingScore == null || state.conceptualGroundingScore < 0.6,
    conceptualGroundingScore: state ? (state.conceptualGroundingScore ?? null) : null,
    nextConceptReviewDue: state ? (state.nextConceptReviewDue || null) : null,
    isSpacedReplayDue: isDue,
    replayInProgress: state ? !!state.replayInProgress : false,
    conceptReviewRung: state ? (state.conceptReviewRung || 0) : 0,
    // Mastery is server-authoritative and comes from the shared pipeline.
    // displayedMasteryPercent stays null until #289 wires BKT into
    // masteryEngine; the client renders whatever it is given and never
    // computes its own.
    mastery: {
      displayedMasteryPercent: state ? (state.displayedMasteryPercent ?? null) : null
    },
    ...extra
  };
}

// ─── Read state ───────────────────────────────────────────────────────────────

async function getState(req, res) {
  const skillId = req.params.skillId;
  const learnerId = learnerIdOf(req);

  if (!mongoReady()) {
    // Degrade to a playable, non-persisted session rather than erroring: this
    // matches how the rest of the server behaves when Mongo is absent.
    return res.status(200).json({
      ...serialiseState(null, skillId),
      success: false,
      persisted: false,
      message: 'Mongo not connected'
    });
  }

  const state = await SkillMasteryState.findOne({ learnerId, skillId });

  // Simul Stage 3 needs the learner's Stage 1 guess back.
  let stage1Guess = null;
  if (skillId === 'simul') {
    const last = await SimulConceptSession
      .findOne({ learnerId })
      .sort({ startedAt: -1 })
      .select('stage1Guess');
    stage1Guess = (last && last.stage1Guess) || null;
  }

  res.status(200).json({ ...serialiseState(state, skillId, { stage1Guess }), persisted: true });
}

// Canonical: identity comes from the token.
router.get('/:skillId/state', auth.requireAuth, requireConceptSkill, async (req, res) => {
  try {
    await getState(req, res);
  } catch (error) {
    console.error(`[ConceptSession] Error getting state for ${req.params.skillId}:`, error.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Legacy shape kept so an older client bundle does not silently read a
// different learner. An explicit id must match the token, otherwise 403.
router.get('/:skillId/state/:learnerId', auth.requireAuth, requireConceptSkill, async (req, res) => {
  if (req.params.learnerId !== learnerIdOf(req)) {
    return res.status(403).json({ success: false, error: 'cannot read another learner state' });
  }
  try {
    await getState(req, res);
  } catch (error) {
    console.error(`[ConceptSession] Error getting state for ${req.params.skillId}:`, error.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ─── Start a spaced review ────────────────────────────────────────────────────
//
// The server, not the client, decides that a run counts as a spaced replay.
// Previously the client was expected to send isSpacedReplay and never did, so
// nextInterval() was never called and the ladder was frozen at rung 0 (#293).
router.post('/:skillId/review/start', auth.requireAuth, requireConceptSkill, async (req, res) => {
  try {
    const skillId = req.params.skillId;
    const learnerId = learnerIdOf(req);

    if (!mongoReady()) {
      return res.status(503).json({ success: false, error: 'Mongo not connected' });
    }

    const state = await SkillMasteryState.findOne({ learnerId, skillId });
    if (!state) {
      return res.status(409).json({ success: false, error: 'no concept state to review' });
    }
    if (!state.nextConceptReviewDue || new Date() < state.nextConceptReviewDue) {
      return res.status(409).json({ success: false, error: 'review not due yet' });
    }

    state.currentStage = 0;
    state.replayInProgress = true;
    await state.save();

    res.status(200).json(serialiseState(state, skillId));
  } catch (error) {
    console.error(`[ConceptSession] Error starting review for ${req.params.skillId}:`, error.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ─── Save a completed stage ───────────────────────────────────────────────────

router.post('/:skillId/session', auth.requireAuth, requireConceptSkill, async (req, res) => {
  try {
    const skillId = req.params.skillId;
    const learnerId = learnerIdOf(req);
    const stageCount = stageCountFor(skillId);

    const stageIndex = Number(req.body.stageIndex);
    if (!Number.isInteger(stageIndex) || stageIndex < 1 || stageIndex > stageCount) {
      return res.status(400).json({
        success: false,
        error: `stageIndex must be an integer in 1..${stageCount}`
      });
    }

    if (!mongoReady()) {
      return res.status(503).json({ success: false, error: 'Mongo not connected' });
    }

    const {
      stage1Predictions,
      stage2Explanation,
      stage3StepperCompleted,
      conceptualGroundingScore,
      // simul-specific
      stage1Guess,
      stage2Predictions,
      stage3PrecisionGap,
      stage4StepperCompleted,
      stage5Explanation
    } = req.body;

    let state = await SkillMasteryState.findOne({ learnerId, skillId });
    if (!state) {
      state = new SkillMasteryState({ learnerId, skillId });
    }

    // isSpacedReplay is server-owned. The client cannot assert it.
    const isSpacedReplay = !!state.replayInProgress;

    const SessionModel = sessionModelFor(skillId);
    const session = new SessionModel({
      learnerId,
      completedStages: Array.from({ length: stageIndex }, (_, i) => i + 1),
      stage1Predictions,
      stage2Explanation,
      stage3StepperCompleted,
      conceptualGroundingScore,
      isSpacedReplay,
      stage1Guess,
      stage2Predictions,
      stage3PrecisionGap,
      stage4StepperCompleted,
      stage5Explanation
    });
    await session.save();

    // Stage progress only ever moves forward within a run.
    state.currentStage = Math.max(state.currentStage || 0, stageIndex);

    if (conceptualGroundingScore !== undefined) {
      state.conceptualGroundingScore = conceptualGroundingScore;
    }

    // ── Spaced repetition ─────────────────────────────────────────────────────
    // Ladder behaviour itself is unchanged (lib/spacingLadder.js); this only
    // fixes when it is invoked.
    const finishedTheFlow = stageIndex >= stageCount;
    if (finishedTheFlow) {
      if (isSpacedReplay) {
        // The review stage reports a straight pass/fail (Stage5Review sends
        // reviewPassed). Older prediction-based stages report rounds, so fall
        // back to the existing accuracy rule. The 0.7 threshold is unchanged.
        let wentWell;
        if (typeof req.body.reviewPassed === 'boolean') {
          wentWell = req.body.reviewPassed;
        } else {
          const rounds = (stage1Predictions && stage1Predictions.length)
            ? stage1Predictions
            : (stage2Predictions || []);
          const total = rounds.length;
          const correct = rounds.filter(r => r && r.correct).length;
          wentWell = total > 0 ? (correct / total) >= 0.7 : false;
        }

        const newRung = nextInterval(state.conceptReviewRung || 0, wentWell);
        state.conceptReviewRung = newRung;
        state.lastConceptReviewAt = new Date();
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + (INTERVAL_DAYS[newRung] || 1));
        state.nextConceptReviewDue = nextDue;
        state.replayInProgress = false;
      } else if (!state.lastConceptReviewAt) {
        // First time through the flow: enter the ladder at rung 0.
        state.lastConceptReviewAt = new Date();
        state.conceptReviewRung = 0;
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + INTERVAL_DAYS[0]);
        state.nextConceptReviewDue = nextDue;
      }
    }

    await state.save();

    // ── Mastery: one attempt, one authoritative server-side update ────────────
    // Routed through the shared LIL pipeline rather than touching BKT here, so
    // Concept Playgrounds is not a mastery island. When #289 wires BKT into
    // masteryEngine, this call starts moving pMastery with no change here.
    let mastery = { isMastered: null, displayedMasteryPercent: state.displayedMasteryPercent ?? null };
    if (isObjectIdLike(learnerId)) {
      try {
        const result = await lilProcess.processAttempt({
          userId: learnerId,
          topicId: skillId,
          difficulty: 'concept',
          userAnswer: `stage:${stageIndex}`,
          // A completed conceptual stage is a successful opportunity.
          isCorrect: true,
          sessionGoal: isSpacedReplay ? 'concept-review' : 'concept',
          telemetry: {},
          prompt: `Concept Playground stage ${stageIndex}`,
          correctAnswer: '',
          display: '',
          options: null,
          questionData: { conceptPlayground: true, skillId, stageIndex }
        });
        mastery = {
          isMastered: result.isMastered ?? null,
          displayedMasteryPercent: result.displayedMasteryPercent ?? state.displayedMasteryPercent ?? null
        };
      } catch (err) {
        // Mastery must never cost the learner their saved progress.
        console.error('[ConceptSession] processAttempt failed:', err.message);
      }
    }

    res.status(200).json({
      ...serialiseState(state, skillId),
      sessionId: session._id,
      mastery
    });
  } catch (error) {
    console.error(`[ConceptSession] Error saving session for ${req.params.skillId}:`, error.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
