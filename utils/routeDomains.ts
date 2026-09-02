import { AppDomainKey } from '../store/useAppStore';

const ROUTE_DOMAIN_MAP: Array<{ match: RegExp; domains: AppDomainKey[] }> = [
  { match: /^\/workbench$/, domains: [] },
  { match: /^\/process$/, domains: ['processes', 'departments'] },
  { match: /^\/org$/, domains: ['departments'] },
  { match: /^\/okr$/, domains: ['strategy', 'departments'] },
  { match: /^\/business-definition$/, domains: ['businesses', 'strategy'] },
  { match: /^\/weekly$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/task-center$/, domains: ['tasks', 'departments', 'strategy'] },
  { match: /^\/execution$/, domains: ['departments', 'strategy'] },
  { match: /^\/review$/, domains: ['departments', 'strategy'] },
  { match: /^\/okr-review$/, domains: ['departments'] },
  { match: /^\/user$/, domains: ['departments'] },
  { match: /^\/roles$/, domains: ['processes', 'departments'] },
  { match: /^\/menu-permissions$/, domains: ['departments'] }
];

export const getRequiredDomains = (pathname: string): AppDomainKey[] => {
  const matched = ROUTE_DOMAIN_MAP.find((route) => route.match.test(pathname));
  return matched?.domains || [];
};
