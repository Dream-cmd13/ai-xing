// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-04-task-title-unbounded';
export const EXPECTED_MANIFEST_DIGEST = '80eff4b39e6f90e90738613401edcb7199f2098c0b64ab359899ea47657f4c98';

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
