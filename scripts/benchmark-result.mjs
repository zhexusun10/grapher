// Distinguish a case assertion failure from a broken/terminated host. A valid
// result artifact remains authoritative even when the host correctly exits 1.
export function classifyHostResult(processResult, artifact) {
  if (processResult.error || processResult.signal || ![0, 1].includes(processResult.status) || !artifact || !['PASS', 'FAIL'].includes(artifact.status)) {
    return {
      status: 'FAIL',
      classification: 'ENVIRONMENT_FAILURE',
      error: `Host failed: status=${processResult.status}, signal=${processResult.signal}, ${(processResult.error ?? processResult.stderr) || 'missing/invalid result.json'}`,
    };
  }
  if ((artifact.status === 'PASS') !== (processResult.status === 0)) {
    return { ...artifact, status: 'FAIL', classification: 'ENVIRONMENT_FAILURE', error: `Host exit ${processResult.status} disagrees with result.json (${artifact.status})` };
  }
  return { ...artifact, classification: artifact.status === 'PASS' ? null : 'IMPLEMENTATION_BUG' };
}
