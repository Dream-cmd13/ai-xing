export const DEFAULT_MAX_KR_INDEX = 100;

const SLOT_PATTERN = /^(.+)-kr-([0-9]+)$/;

export function parseReviewSlot(alignedKrId, taskId, maxKrIndex = DEFAULT_MAX_KR_INDEX) {
  if (alignedKrId === null || alignedKrId === undefined || alignedKrId === '') {
    return {
      ok: true,
      aligned: false,
      reviewKey: `__task__:${taskId || 'unknown'}`,
      krIndex: 0,
    };
  }

  if (typeof alignedKrId !== 'string' || alignedKrId.length > 128) {
    return { ok: false, reason: 'ALIGNED_KR_ID_INVALID' };
  }

  const match = SLOT_PATTERN.exec(alignedKrId);
  if (!match || match[1].trim().length === 0) {
    return { ok: false, reason: 'ALIGNED_KR_ID_INVALID' };
  }

  const digits = match[2];
  if (digits.length > 3) return { ok: false, reason: 'KR_INDEX_OUT_OF_RANGE' };

  const krIndex = Number(digits);
  if (!Number.isSafeInteger(krIndex) || krIndex < 0 || krIndex > maxKrIndex) {
    return { ok: false, reason: 'KR_INDEX_OUT_OF_RANGE' };
  }

  return {
    ok: true,
    aligned: true,
    reviewKey: match[1],
    krIndex,
  };
}
