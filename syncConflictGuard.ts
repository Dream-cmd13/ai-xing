type PendingMutation = {
  table: string;
  id: string;
  normalized: string;
  expectedRowVersion: number | null;
  createdAt: number;
};

const PENDING_TTL_MS = 15000;
const pendingMutations = new Map<string, PendingMutation>();

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
  for (const [key, mutation] of pendingMutations.entries()) {
    if (now - mutation.createdAt > PENDING_TTL_MS) {
      pendingMutations.delete(key);
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
  pendingMutations.set(buildKey(table, id), {
    table,
    id,
    normalized: normalizeForConflictComparison(payload),
    expectedRowVersion: currentRowVersion == null ? null : currentRowVersion + 1,
    createdAt: Date.now()
  });
};

export const clearPendingMutation = (table: string, id: string) => {
  pendingMutations.delete(buildKey(table, id));
};

export const matchesPendingMutation = (table: string, id: string, payload: any): boolean => {
  cleanupExpired();
  const pending = pendingMutations.get(buildKey(table, id));
  if (!pending) return false;

  const normalizedPayload = normalizeForConflictComparison(payload);
  const payloadRowVersion =
    typeof payload?.rowVersion === 'number' ? payload.rowVersion : Number(payload?.rowVersion ?? NaN);

  const rowVersionMatches =
    pending.expectedRowVersion == null ||
    Number.isNaN(payloadRowVersion) ||
    payloadRowVersion === pending.expectedRowVersion;

  if (rowVersionMatches && normalizedPayload === pending.normalized) {
    pendingMutations.delete(buildKey(table, id));
    return true;
  }

  return false;
};
