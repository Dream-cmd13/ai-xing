import { normalizeForConflictComparison } from '../syncConflictGuard.ts';

const DEPARTMENT_PATCH_FIELDS = [
  'name',
  'managerName',
  'responsibilities',
  'roles',
  'roleMembers',
  'attributes',
  'subDepartments',
  'okrs',
  'reviews',
];

export const getChangedDepartmentFields = (previousDept, nextDept) => {
  if (!previousDept || !nextDept) return [];

  return DEPARTMENT_PATCH_FIELDS.filter((field) => (
    normalizeForConflictComparison(previousDept[field]) !==
    normalizeForConflictComparison(nextDept[field])
  ));
};

export const buildDepartmentPatch = (previousDept, nextDept) => {
  const changedFields = getChangedDepartmentFields(previousDept, nextDept);
  const patch = { rowVersion: previousDept?.rowVersion ?? 0 };

  changedFields.forEach((field) => {
    patch[field] = nextDept[field];
  });

  return patch;
};

export const hasDepartmentPatchConflict = (previousDept, localDept, latestDept) => {
  const localFields = new Set(getChangedDepartmentFields(previousDept, localDept));
  const remoteFields = getChangedDepartmentFields(previousDept, latestDept);

  return remoteFields.some((field) => localFields.has(field));
};

export const applyDepartmentPatch = (baseDept, patch) => {
  const merged = { ...baseDept };
  DEPARTMENT_PATCH_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      merged[field] = patch[field];
    }
  });
  if (patch.rowVersion !== undefined) {
    merged.rowVersion = patch.rowVersion;
  }
  return merged;
};
