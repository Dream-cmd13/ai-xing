// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-14-review-text-unbounded';
export const EXPECTED_MANIFEST_DIGEST = '02093539289439df2e5081c4208ea41e0528d27b8cbe54b301070c36ab039376';

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
