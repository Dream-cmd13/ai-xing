export const parseTaskTags = (value) => {
  if (typeof value !== 'string') return [];

  return value
    .split(/[,，]/)
    .map(tag => tag.trim())
    .filter(Boolean);
};
