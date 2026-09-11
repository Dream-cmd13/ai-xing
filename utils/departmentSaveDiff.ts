import type { Department } from '../types.ts';
import { normalizeForConflictComparison } from '../syncConflictGuard.ts';

export interface DepartmentSavePayload {
  nextDepartments: Department[];
  previousDepartments: Department[];
}

const assertUniqueTopLevelIds = (departments: Department[]) => {
  const ids = new Set<string>();

  for (const department of departments) {
    if (ids.has(department.id)) {
      throw new Error(`Duplicate top-level department id: ${department.id}`);
    }
    ids.add(department.id);
  }
};

export const buildDepartmentSavePayload = (
  nextDepartments: Department[],
  previousDepartments: Department[],
): DepartmentSavePayload => {
  assertUniqueTopLevelIds(nextDepartments);
  assertUniqueTopLevelIds(previousDepartments);

  const previousById = new Map(previousDepartments.map((department) => [department.id, department]));
  const nextById = new Map(nextDepartments.map((department) => [department.id, department]));

  const nextChanged = nextDepartments.filter((nextDepartment) => {
    const previousDepartment = previousById.get(nextDepartment.id);
    return !previousDepartment
      || normalizeForConflictComparison(nextDepartment)
        !== normalizeForConflictComparison(previousDepartment);
  });

  const previousChanged = previousDepartments.filter((previousDepartment) => {
    const nextDepartment = nextById.get(previousDepartment.id);
    return !nextDepartment
      || normalizeForConflictComparison(previousDepartment)
        !== normalizeForConflictComparison(nextDepartment);
  });

  return {
    nextDepartments: nextChanged,
    previousDepartments: previousChanged,
  };
};
