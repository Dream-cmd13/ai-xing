// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-01-task-date-weeks';
export const EXPECTED_MANIFEST_DIGEST = '9061382fd04ea9deb77565a3c90ffb82f9e49a8da1a20a94000783604392bf5c';

export function hasExpectedReleaseContract(value) {
  return Boolean(value)
    && value.status === 'ready'
    && value.releaseId === RELEASE_ID
    && value.manifestDigest === EXPECTED_MANIFEST_DIGEST
    && value.requiredMigrations === true
    && value.functionPrivileges === true
    && value.taskDateWeekFunction === true
    && value.taskDateWeekTrigger === true
    && value.taskPeriodDataConsistent === true;
}
