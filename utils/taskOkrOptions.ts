import { CompanyStrategy, Department, User } from '../types';

export interface TaskOkrOptionGroup {
  label: string;
  options: { id: string; name: string }[];
}

interface QuarterScope {
  year: number;
  quarter: string;
}

interface CreateTaskOkrGroupsParams {
  companyOKRs: CompanyStrategy['companyOKRs'];
  departments: Department[];
  currentUser: User;
  ownerId?: string;
  users?: User[];
  isAdmin?: boolean;
  startDate?: number;
  dueDate?: number;
  fallbackWeekId?: string | null;
}

const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

const flattenDepartments = (departments: Department[]): Department[] => {
  const list: Department[] = [];
  const walk = (items: Department[]) => {
    items.forEach((department) => {
      list.push(department);
      walk(department.subDepartments || []);
    });
  };
  walk(departments);
  return list;
};

const collectAncestorDepartmentIds = (
  departments: Department[],
  targetDepartmentId?: string
): string[] => {
  if (!targetDepartmentId) return [];

  const walk = (items: Department[], ancestors: string[]): string[] | null => {
    for (const department of items) {
      const nextAncestors = [...ancestors, department.id];
      if (department.id === targetDepartmentId) {
        return nextAncestors;
      }

      const match = walk(department.subDepartments || [], nextAncestors);
      if (match) {
        return match;
      }
    }

    return null;
  };

  return walk(departments, []) || [];
};

const getQuarterFromMonth = (monthIndex: number): string => QUARTERS[Math.floor(monthIndex / 3)] || 'Q1';

const getQuarterFromDate = (value: number): QuarterScope | null => {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getUTCFullYear(),
    quarter: getQuarterFromMonth(date.getUTCMonth())
  };
};

const getQuarterFromWeekId = (weekId?: string | null): QuarterScope | null => {
  if (!weekId) return null;
  const match = ISO_WEEK_PATTERN.exec(weekId);
  if (!match) return null;

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    return null;
  }

  let quarter = 'Q1';
  if (week >= 14 && week <= 26) quarter = 'Q2';
  else if (week >= 27 && week <= 39) quarter = 'Q3';
  else if (week >= 40) quarter = 'Q4';

  return { year, quarter };
};

const getQuarterScopes = (
  startDate?: number,
  dueDate?: number,
  fallbackWeekId?: string | null
): QuarterScope[] => {
  const startScope = getQuarterFromDate(startDate as number);
  const endScope = getQuarterFromDate(dueDate as number);

  if (startScope || endScope) {
    const start = startScope || endScope!;
    const end = endScope || startScope!;
    const scopeKeys = new Set<string>();
    const orderedScopes: QuarterScope[] = [];
    const startIndex = start.year * 4 + QUARTERS.indexOf(start.quarter as (typeof QUARTERS)[number]);
    const endIndex = end.year * 4 + QUARTERS.indexOf(end.quarter as (typeof QUARTERS)[number]);
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);

    for (let index = from; index <= to; index += 1) {
      const year = Math.floor(index / 4);
      const quarter = QUARTERS[index % 4];
      const key = `${year}-${quarter}`;
      if (!scopeKeys.has(key)) {
        scopeKeys.add(key);
        orderedScopes.push({ year, quarter });
      }
    }

    return orderedScopes;
  }

  const weekScope = getQuarterFromWeekId(fallbackWeekId);
  return weekScope ? [weekScope] : [];
};

export const getWeekDateRange = (
  weekId?: string | null
): { startDate: number; dueDate: number } | null => {
  if (!weekId) return null;
  const match = ISO_WEEK_PATTERN.exec(weekId);
  if (!match) return null;

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    return null;
  }

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);

  const weekStart = new Date(week1Monday);
  weekStart.setUTCDate(week1Monday.getUTCDate() + ((week - 1) * 7));
  weekStart.setUTCHours(12, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  weekEnd.setUTCHours(12, 0, 0, 0);

  return {
    startDate: weekStart.getTime(),
    dueDate: weekEnd.getTime()
  };
};

export const createTaskOkrGroups = ({
  companyOKRs,
  departments,
  currentUser,
  ownerId,
  users = [],
  isAdmin = false,
  startDate,
  dueDate,
  fallbackWeekId
}: CreateTaskOkrGroupsParams): TaskOkrOptionGroup[] => {
  const quarterScopes = getQuarterScopes(startDate, dueDate, fallbackWeekId);
  const scopeYears = quarterScopes.length > 0
    ? Array.from(new Set(quarterScopes.map((scope) => scope.year)))
    : Array.from(new Set([
        getQuarterFromDate(startDate || dueDate || NaN)?.year,
        getQuarterFromWeekId(fallbackWeekId)?.year
      ].filter((value): value is number => typeof value === 'number')));

  const fallbackYear = new Date().getFullYear();
  const yearsToLoad = scopeYears.length > 0 ? scopeYears : [fallbackYear];
  const groups: TaskOkrOptionGroup[] = [];

  yearsToLoad.forEach((year) => {
    const companyOptions: { id: string; name: string }[] = [];
    (companyOKRs[year] || []).forEach((okr) => {
      (okr.keyResults || []).forEach((kr, index) => {
        companyOptions.push({
          id: `${okr.id}-kr-${index}`,
          name: kr
        });
      });
    });

    if (companyOptions.length > 0) {
      groups.push({
        label: yearsToLoad.length > 1 ? `公司战略指标（${year}）` : '公司战略指标',
        options: companyOptions
      });
    }
  });

  const allDepartments = flattenDepartments(departments);
  const ownerDepartmentId = ownerId
    ? users.find((user) => user.id === ownerId)?.departmentId
    : undefined;
  const allowedDepartmentIds = isAdmin
    ? new Set(allDepartments.map((department) => department.id))
    : new Set(
        collectAncestorDepartmentIds(
          departments,
          ownerDepartmentId || currentUser.departmentId
        )
      );

  if (allowedDepartmentIds.size === 0) {
    return groups;
  }

  const scopeKeySet = new Set(quarterScopes.map((scope) => `${scope.year}-${scope.quarter}`));
  const showScopeSuffix = isAdmin || scopeKeySet.size > 1;

  allDepartments
    .filter((department) => allowedDepartmentIds.has(department.id))
    .forEach((department) => {
      const departmentOptions: { id: string; name: string }[] = [];

      if (isAdmin) {
        Object.entries(department.okrs || {}).forEach(([yearText, okrGroups]) => {
          Object.entries(okrGroups || {}).forEach(([period, okrs]) => {
            (okrs || []).forEach((okr) => {
              (okr.keyResults || []).forEach((kr, index) => {
                departmentOptions.push({
                  id: `${okr.id}-kr-${index}`,
                  name: `${kr} (${yearText} ${period})`
                });
              });
            });
          });
        });
      } else {
        quarterScopes.forEach(({ year, quarter }) => {
          const okrs = department.okrs?.[year]?.[quarter] || [];
          okrs.forEach((okr) => {
            (okr.keyResults || []).forEach((kr, index) => {
              departmentOptions.push({
                id: `${okr.id}-kr-${index}`,
                name: showScopeSuffix ? `${kr} (${year} ${quarter})` : kr
              });
            });
          });
        });
      }

      if (departmentOptions.length > 0) {
        groups.push({
          label: `${department.name} 指标`,
          options: departmentOptions
        });
      }
    });

  return groups;
};
