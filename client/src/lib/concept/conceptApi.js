// Shared fetch layer for the Concept Playgrounds.
//
// Two things this fixes, both found in the #293 audit:
//   1. The apps used `VITE_API_URL || 'http://localhost:4000'`. Every other
//      caller in the app uses VITE_API_BASE_URL, which is '' in the normal
//      build and '/summership' in the subpath deploy. The old base pointed a
//      deployed bundle at the developer's laptop.
//   2. No request carried an Authorization header, and learner identity came
//      from an anonymous localStorage id. Identity is now the JWT, and the
//      server reads it from the token.

const API = import.meta.env.VITE_API_BASE_URL || '';

export class ConceptApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ConceptApiError';
    this.status = status;
    // 401 means the session expired; callers surface a login prompt rather
    // than a generic failure.
    this.isAuthError = status === 401;
  }
}

async function conceptFetch(path, options = {}) {
  let token = null;
  try {
    token = localStorage.getItem('tenali-auth-token');
  } catch {
    token = null;
  }

  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API}${path}`, { ...options, headers });
  } catch (networkErr) {
    throw new ConceptApiError(`Network error: ${networkErr.message}`, 0);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message = (body && (body.error || body.message)) || `Request failed (HTTP ${res.status})`;
    throw new ConceptApiError(message, res.status);
  }
  return body;
}

export function fetchConceptState(skillId) {
  return conceptFetch(`/api/concept-session/${skillId}/state`);
}

export function saveConceptStage(skillId, stageIndex, sessionData = {}) {
  return conceptFetch(`/api/concept-session/${skillId}/session`, {
    method: 'POST',
    body: JSON.stringify({ stageIndex, ...sessionData })
  });
}

export function startConceptReview(skillId) {
  return conceptFetch(`/api/concept-session/${skillId}/review/start`, { method: 'POST' });
}

export function logConceptAttempt(payload) {
  return conceptFetch('/api/concept-playgrounds/attempt', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}
