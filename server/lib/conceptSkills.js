'use strict';

// The Concept Playground skills that exist, and how many stages each has.
//
// Single source of truth for skill validation. Both conceptSession.js and
// conceptPlay.js validate against this, so an unknown skillId is rejected in
// one place rather than falling through to a Mongoose model lookup.
//
// stageCount is the number of conceptual stages before the completion screen:
//   qformula: Predict -> Derivation -> Guided -> Independent -> Review
//   simul:    Predict -> Grid -> Precision -> Elimination -> Cases
const CONCEPT_SKILLS = {
  qformula: { stageCount: 5, label: 'Quadratic Formula' },
  simul:    { stageCount: 5, label: 'Simultaneous Equations' }
};

function isConceptSkill(skillId) {
  return Object.prototype.hasOwnProperty.call(CONCEPT_SKILLS, skillId);
}

function stageCountFor(skillId) {
  return isConceptSkill(skillId) ? CONCEPT_SKILLS[skillId].stageCount : 0;
}

module.exports = { CONCEPT_SKILLS, isConceptSkill, stageCountFor };
