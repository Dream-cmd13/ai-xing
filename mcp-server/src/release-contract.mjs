// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-07-workbench-shanghai-day';
export const EXPECTED_MANIFEST_DIGEST = '624c3fdb85ce9702e9d7e64b1b9a38f24fcf76b1ecb280172e97ce448d543a97';

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
