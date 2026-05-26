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
