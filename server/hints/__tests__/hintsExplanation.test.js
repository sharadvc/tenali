'use strict';

const express = require('express');
const request = require('supertest');
const hintsRouter = require('../index');
const { generateExplanation } = require('../../explanations');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hints', hintsRouter);
  return app;
}

describe('Hints & Explanation decoupling from global', () => {
  test('global.generateExplanation is undefined', () => {
    expect(global.generateExplanation).toBeUndefined();
  });

  test('generateExplanation direct module export produces valid explanation', () => {
    const req = { path: '/addition-api/check', body: { a: 5, b: 7 } };
    const data = { a: 5, b: 7, correctAnswer: 12, userAnswer: 12 };
    const explanation = generateExplanation(req, data);
    expect(typeof explanation).toBe('string');
    expect(explanation.length).toBeGreaterThan(0);
  });

  test('POST /api/hints/unlock with level 3 generates hint using imported generateExplanation without global', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/hints/unlock')
      .send({
        concept: 'addition',
        questionId: 'test_q_123',
        level: 3,
        questionData: { num1: 15, num2: 27 },
        answerData: { correctAnswer: 42, display: '42' },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.hint).toBe('string');
    expect(res.body.hint.length).toBeGreaterThan(0);
    expect(global.generateExplanation).toBeUndefined();
  });
});
