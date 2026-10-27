// STUB: allowed payment status transitions. Review before implementing logic.
const ALLOWED_TRANSITIONS = {
  CREATED: ['PENDING', 'FAILED', 'CANCELLED', 'USER_DROPPED', 'EXPIRED', 'SUCCESS'],
  PENDING: ['SUCCESS', 'FAILED', 'CANCELLED', 'USER_DROPPED', 'EXPIRED'],
  SUCCESS: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  USER_DROPPED: [],
  EXPIRED: [],
  REFUNDED: [],
};

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

module.exports = { ALLOWED_TRANSITIONS, canTransition };
