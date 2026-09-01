// This value changes only when a new release contract is published. The
// digest covers the ordered transactional manifest, excluding the contract
// migration itself and deferred indexes.
export const RELEASE_ID = '2026-09-01';
export const EXPECTED_MANIFEST_DIGEST = '47a58a1fbf69cea7564a2e2a67a0fde594924b957f4b5953e04344e5990757f8';

export function hasExpectedReleaseContract(value) {
  return Boolean(value)
    && value.status === 'ready'
    && value.releaseId === RELEASE_ID
    && value.manifestDigest === EXPECTED_MANIFEST_DIGEST
    && value.requiredMigrations === true
    && value.functionPrivileges === true;
}
