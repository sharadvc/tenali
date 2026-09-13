import React from 'react';

// Shown once the learner has finished every conceptual stage.
//
// `PracticeApp` is the topic's existing quiz/drill component (QFormulaApp or
// SimulQuizApp). It was previously named `QFormulaApp` even when a Simul app
// was passed in, which read as a bug.
export default function CompletionScreen({
  onBack,
  nextReviewDue,
  isSpacedReplayDue,
  onStartReview,
  mastery,
  PracticeApp
}) {
  const [showPractice, setShowPractice] = React.useState(false);

  if (showPractice) {
    return (
      <div style={{ marginTop: '2rem' }}>
        <PracticeApp onBack={() => setShowPractice(false)} />
      </div>
    );
  }

  const displayed = mastery && typeof mastery.displayedMasteryPercent === 'number'
    ? Math.round(mastery.displayedMasteryPercent)
    : null;

  return (
    <div className="welcome-box" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎉</div>
      <h2 style={{ color: 'var(--clr-accent)', marginBottom: '1rem' }}>You're all caught up!</h2>

      {/* Mastery is whatever the server reports. The client never computes it. */}
      {displayed !== null && (
        <p style={{ marginBottom: '1rem' }}>Mastery: <strong>{displayed}%</strong></p>
      )}

      <p style={{ color: 'var(--clr-text-soft)', marginBottom: '2rem' }}>
        {isSpacedReplayDue
          ? 'Your spaced review is due. A quick check keeps it fresh.'
          : nextReviewDue
            ? `Next review due on ${new Date(nextReviewDue).toLocaleDateString()} at ${new Date(nextReviewDue).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : "You've worked through the concept. Come back later for your next spaced review."}
      </p>

      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="secondary-btn" onClick={onBack}>Back to Menu</button>
        {isSpacedReplayDue && onStartReview && (
          <button className="primary-btn" onClick={onStartReview}>Start review</button>
        )}
        {PracticeApp && (
          <button className="primary-btn" onClick={() => setShowPractice(true)}>Free Practice</button>
        )}
      </div>
    </div>
  );
}
