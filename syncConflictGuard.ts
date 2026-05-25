type PendingMutation = {
  table: string;
  id: string;
  normalized: string;
  expectedRowVersion: number | null;
  createdAt: number;
};

const PENDING_TTL_MS = 15000;
const pendingMutations = new Map<string, PendingMutation[]>();

const metadataKeys = new Set(['updatedAt', 'updated_at', 'rowVersion', 'row_version']);

const normalizeValue = (value: any): any => {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    const normalizedEntries = Object.keys(value)
      .filter((key) => !metadataKeys.has(key))
      .sort()
      .map((key) => [key, normalizeValue(value[key])]);

    return Object.fromEntries(normalizedEntries);
  }

  return value;
};

export const normalizeForConflictComparison = (value: any): string =>
  JSON.stringify(normalizeValue(value));

const buildKey = (table: string, id: string) => `${table}:${id}`;

const cleanupExpired = () => {
  const now = Date.now();
  for (const [key, mutations] of pendingMutations.entries()) {
    const validMutations = mutations.filter((mutation) => now - mutation.createdAt <= PENDING_TTL_MS);
    if (validMutations.length === 0) {
      pendingMutations.delete(key);
    } else {
      pendingMutations.set(key, validMutations);
    }
  }
};

export const markPendingMutation = (
  table: string,
  id: string,
  payload: any,
  currentRowVersion?: number | null
) => {
  cleanupExpired();
  const key = buildKey(table, id);
  const existingMutations = pendingMutations.get(key) || [];
  existingMutations.push({
    table,
    id,
    normalized: normalizeForConflictComparison(payload),
    expectedRowVersion: currentRowVersion == null ? null : currentRowVersion + 1,
    createdAt: Date.now()
  });
  pendingMutations.set(key, existingMutations);
};

export const clearPendingMutation = (table: string, id: string) => {
  pendingMutations.delete(buildKey(table, id));
};

export const matchesPendingMutation = (table: string, id: string, payload: any): boolean => {
  cleanupExpired();
  const key = buildKey(table, id);
  const pendingList = pendingMutations.get(key);
  if (!pendingList || pendingList.length === 0) return false;

  const normalizedPayload = normalizeForConflictComparison(payload);
  const payloadRowVersion =
    typeof payload?.rowVersion === 'number' ? payload.rowVersion : Number(payload?.rowVersion ?? NaN);

  const matchedIndex = pendingList.findIndex((pending) => {
    const rowVersionMatches =
      pending.expectedRowVersion == null ||
      Number.isNaN(payloadRowVersion) ||
      payloadRowVersion === pending.expectedRowVersion;
    return rowVersionMatches && normalizedPayload === pending.normalized;
  });

  if (matchedIndex >= 0) {
    const remaining = pendingList.filter((_, index) => index !== matchedIndex);
    if (remaining.length === 0) {
      pendingMutations.delete(key);
    } else {
      pendingMutations.set(key, remaining);
    }
    return true;
  }

  return false;
};
