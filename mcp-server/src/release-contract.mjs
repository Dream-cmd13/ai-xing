// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-03-task-title-unbounded';
export const EXPECTED_MANIFEST_DIGEST = 'd75620aa041aad362e91a67b58ac8727ba964bfe377abea9d8d3668900e4cac7';

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
