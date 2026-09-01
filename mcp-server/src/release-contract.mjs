// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-01';
export const EXPECTED_MANIFEST_DIGEST = '284d74705f7c31ab645f834f868b349ef7568077ea667502afdf10066a728c0d';

export function hasExpectedReleaseContract(value) {
  return Boolean(value)
    && value.status === 'ready'
    && value.releaseId === RELEASE_ID
    && value.manifestDigest === EXPECTED_MANIFEST_DIGEST
    && value.requiredMigrations === true
    && value.functionPrivileges === true;
}
