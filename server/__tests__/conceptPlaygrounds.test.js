'use strict';
// Integration tests for the Concept Playgrounds API (#293).
//
// These run against a real mongod on 127.0.0.1:27017 using a scratch database
// that is dropped afterwards. They mount the routers the same way index.js
// does, rather than booting the whole monolith, so they stay fast and do not
// depend on the topic-question data files.

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('../auth');

const TEST_DB = 'mongodb://127.0.0.1:27017/tenali_concept_test';

// Two distinct learners, both valid ObjectIds so the mastery path is exercised.
const LEARNER_A = new mongoose.Types.ObjectId().toString();
const LEARNER_B = new mongoose.Types.ObjectId().toString();

function tokenFor(id, username) {
  return jwt.sign({ sub: id, username, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
}

const TOKEN_A = tokenFor(LEARNER_A, 'learner_a');
const TOKEN_B = tokenFor(LEARNER_B, 'learner_b');

let app;
let SkillMasteryState;

beforeAll(async () => {
  await mongoose.connect(TEST_DB);

  // Require after connecting so the models bind to this connection.
  const conceptSession = require('../conceptSession');
  const conceptPlay = require('../conceptPlay');
  SkillMasteryState = require('../models/SkillMasteryState');

  app = express();
  app.use(express.json());
  app.use('/api/concept-session', conceptSession);
  app.use('/api/concept-playgrounds', conceptPlay);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map(c => c.deleteMany({})));
});

// ─── Mounting ─────────────────────────────────────────────────────────────────

describe('routes are mounted', () => {
  test('GET state is reachable (not 404 from a missing mount)', async () => {
    const res = await request(app)
      .get('/api/concept-session/qformula/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
  });

  test('POST attempt is reachable', async () => {
    const res = await request(app)
      .post('/api/concept-playgrounds/attempt')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ skillId: 'qformula', templateUsed: 'EquationSandbox', proximityScore: 0.8, attempts: 2 });
    expect(res.status).toBe(201);
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('authorization', () => {
  test('unauthenticated state read is rejected', async () => {
    const res = await request(app).get('/api/concept-session/qformula/state');
    expect(res.status).toBe(401);
  });

  test('unauthenticated session save is rejected', async () => {
    const res = await request(app)
      .post('/api/concept-session/qformula/session')
      .send({ stageIndex: 1 });
    expect(res.status).toBe(401);
  });

  test('unauthenticated telemetry is rejected', async () => {
    const res = await request(app)
      .post('/api/concept-playgrounds/attempt')
      .send({ skillId: 'qformula', templateUsed: 'X', proximityScore: 1, attempts: 1 });
    expect(res.status).toBe(401);
  });

  test('an expired token is rejected', async () => {
    const expired = jwt.sign({ sub: LEARNER_A, username: 'a' }, JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/api/concept-session/qformula/state')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  test('one learner cannot read another learner private state', async () => {
    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 3 });

    // Legacy id-in-path shape: asking for A's state with B's token is refused.
    const res = await request(app)
      .get(`/api/concept-session/qformula/state/${LEARNER_A}`)
      .set('Authorization', `Bearer ${TOKEN_B}`);
    expect(res.status).toBe(403);
  });

  test('learner identity comes from the token, not the body', async () => {
    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_B}`)
      .send({ stageIndex: 2, learnerId: LEARNER_A });   // spoof attempt

    const stateA = await SkillMasteryState.findOne({ learnerId: LEARNER_A, skillId: 'qformula' });
    const stateB = await SkillMasteryState.findOne({ learnerId: LEARNER_B, skillId: 'qformula' });
    expect(stateA).toBeNull();
    expect(stateB.currentStage).toBe(2);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe('validation', () => {
  test('an unknown skill is rejected', async () => {
    const res = await request(app)
      .get('/api/concept-session/not-a-skill/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(404);
  });

  test('an unknown skill is rejected on save too', async () => {
    const res = await request(app)
      .post('/api/concept-session/not-a-skill/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 1 });
    expect(res.status).toBe(404);
  });

  test.each([[0], [6], [-1], ['two'], [null]])('stageIndex %p is rejected', async (stageIndex) => {
    const res = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex });
    expect(res.status).toBe(400);
  });

  test('telemetry rejects a non-numeric proximityScore', async () => {
    const res = await request(app)
      .post('/api/concept-playgrounds/attempt')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ skillId: 'qformula', templateUsed: 'X', proximityScore: 'high', attempts: 1 });
    expect(res.status).toBe(400);
  });
});

// ─── State ────────────────────────────────────────────────────────────────────

describe('state', () => {
  test('a new learner gets a valid initial state', async () => {
    const res = await request(app)
      .get('/api/concept-session/qformula/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.currentStage).toBe(0);
    expect(res.body.stageCount).toBe(5);
    expect(res.body.showRoteBanner).toBe(true);
    expect(res.body.isSpacedReplayDue).toBe(false);
    expect(res.body.nextConceptReviewDue).toBeNull();
    expect(res.body.mastery).toBeDefined();
  });

  test('stage progress persists and is returned on reload', async () => {
    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 1, stage1Predictions: [{ sliderChanged: 'a', predicted: 'more', actual: 'more', correct: true }] });

    const res = await request(app)
      .get('/api/concept-session/qformula/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.body.currentStage).toBe(1);
  });

  test('stage progress never moves backwards', async () => {
    const post = (stageIndex) => request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex });

    await post(3);
    const res = await post(2);
    expect(res.body.currentStage).toBe(3);
  });

  test('simul Stage 3 gets the learner Stage 1 guess back', async () => {
    await request(app)
      .post('/api/concept-session/simul/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 1, stage1Guess: { x: 4, y: -2 } });

    const res = await request(app)
      .get('/api/concept-session/simul/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.body.stage1Guess).toMatchObject({ x: 4, y: -2 });
  });
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

describe('session persistence', () => {
  test('a saved session is written and returns its id', async () => {
    const res = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 2, stage2Explanation: { text: 'complete the square', keywordMatch: true } });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();

    const QformulaConceptSession = require('../models/QformulaConceptSession');
    const saved = await QformulaConceptSession.findById(res.body.sessionId);
    expect(saved.learnerId).toBe(LEARNER_A);
    expect(saved.completedStages).toEqual([1, 2]);
    expect(saved.stage2Explanation.text).toBe('complete the square');
  });

  test('a correct and an incorrect review are both accepted', async () => {
    for (const reviewPassed of [true, false]) {
      const res = await request(app)
        .post('/api/concept-session/qformula/session')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ stageIndex: 5, reviewPassed });
      expect(res.status).toBe(200);
    }
  });

  test('conceptualGroundingScore is stored and clears the rote banner', async () => {
    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 4, conceptualGroundingScore: 0.9 });

    const res = await request(app)
      .get('/api/concept-session/qformula/state')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.body.conceptualGroundingScore).toBe(0.9);
    expect(res.body.showRoteBanner).toBe(false);
  });
});

// ─── Spaced repetition ────────────────────────────────────────────────────────

describe('spaced repetition', () => {
  const finishFlow = () => request(app)
    .post('/api/concept-session/qformula/session')
    .set('Authorization', `Bearer ${TOKEN_A}`)
    .send({ stageIndex: 5 });

  test('finishing the flow schedules the first review at rung 0 (1 day)', async () => {
    const res = await finishFlow();
    expect(res.body.conceptReviewRung).toBe(0);
    expect(res.body.nextConceptReviewDue).toBeTruthy();

    const due = new Date(res.body.nextConceptReviewDue);
    const days = Math.round((due - Date.now()) / 86400000);
    expect(days).toBe(1);
  });

  test('a review that is not due cannot be started', async () => {
    await finishFlow();
    const res = await request(app)
      .post('/api/concept-session/qformula/review/start')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(res.status).toBe(409);
  });

  test('a passed review advances the ladder 0 -> 1 (3 days)', async () => {
    await finishFlow();
    // Make the review due.
    await SkillMasteryState.updateOne(
      { learnerId: LEARNER_A, skillId: 'qformula' },
      { $set: { nextConceptReviewDue: new Date(Date.now() - 1000) } }
    );

    const started = await request(app)
      .post('/api/concept-session/qformula/review/start')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    expect(started.status).toBe(200);
    expect(started.body.currentStage).toBe(0);
    expect(started.body.replayInProgress).toBe(true);

    const done = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 5, reviewPassed: true });

    expect(done.body.conceptReviewRung).toBe(1);
    expect(done.body.replayInProgress).toBe(false);
    const days = Math.round((new Date(done.body.nextConceptReviewDue) - Date.now()) / 86400000);
    expect(days).toBe(3);
  });

  test('a failed review does not advance past rung 0', async () => {
    await finishFlow();
    await SkillMasteryState.updateOne(
      { learnerId: LEARNER_A, skillId: 'qformula' },
      { $set: { nextConceptReviewDue: new Date(Date.now() - 1000) } }
    );
    await request(app)
      .post('/api/concept-session/qformula/review/start')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    const done = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 5, reviewPassed: false });

    expect(done.body.conceptReviewRung).toBe(0);
  });

  test('currentStage and conceptReviewRung stay separate concepts', async () => {
    await finishFlow();
    await SkillMasteryState.updateOne(
      { learnerId: LEARNER_A, skillId: 'qformula' },
      { $set: { nextConceptReviewDue: new Date(Date.now() - 1000) } }
    );
    await request(app)
      .post('/api/concept-session/qformula/review/start')
      .set('Authorization', `Bearer ${TOKEN_A}`);
    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 5, reviewPassed: true });

    const state = await SkillMasteryState.findOne({ learnerId: LEARNER_A, skillId: 'qformula' });
    expect(state.currentStage).toBe(5);      // finished the flow
    expect(state.conceptReviewRung).toBe(1); // one rung up the ladder
  });
});

// ─── Mastery ──────────────────────────────────────────────────────────────────

describe('mastery goes through the shared server-side path', () => {
  test('completing a stage drives lil/processAttempt', async () => {
    const processAttempt = require('../lil/processAttempt');
    const spy = vi.spyOn(processAttempt, 'processAttempt');

    await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0][0];
    expect(payload.userId).toBe(LEARNER_A);
    expect(payload.topicId).toBe('qformula');
    // A completed conceptual stage is a success, never an incorrect attempt.
    expect(payload.isCorrect).toBe(true);

    spy.mockRestore();
  });

  test('a mastery failure does not lose the learner saved progress', async () => {
    const processAttempt = require('../lil/processAttempt');
    const spy = vi.spyOn(processAttempt, 'processAttempt')
      .mockRejectedValue(new Error('mastery pipeline down'));

    const res = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 2 });

    expect(res.status).toBe(200);
    expect(res.body.currentStage).toBe(2);

    spy.mockRestore();
  });

  test('the response carries a mastery block for the client to render', async () => {
    const res = await request(app)
      .post('/api/concept-session/qformula/session')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ stageIndex: 1 });

    expect(res.body.mastery).toHaveProperty('displayedMasteryPercent');
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe('telemetry', () => {
  test('an attempt is persisted against the token learner', async () => {
    const res = await request(app)
      .post('/api/concept-playgrounds/attempt')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({
        skillId: 'sandbox_trig',
        classLevel: 'Class 1',
        templateUsed: 'EquationSandbox',
        proximityScore: 0.7,
        attempts: 3,
        selfExplanationText: 'x + 2 = 5',
        match: true
      });

    expect(res.status).toBe(201);

    const ConceptPlayAttempt = require('../models/ConceptPlayAttempt');
    const saved = await ConceptPlayAttempt.findById(res.body.attemptId);
    expect(saved.learnerId).toBe(LEARNER_A);
    expect(saved.proximityScore).toBe(0.7);
    expect(saved.attempts).toBe(3);
  });
});
