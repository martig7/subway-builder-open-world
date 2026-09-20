// The native tile and cross-city evaluators share one allocation slot. Await
// host fare callbacks inside the slot so a partially prepared job still counts.
let tail = Promise.resolve();
function releaseRoutingJobResult() {}
export function runRoutingJob(operation) {
  const job = tail.then(operation);
  // The queue retains ordering, never the last job's potentially large payload.
  // A catch-only tail forwards successful results and keeps them alive at idle.
  tail = job.then(releaseRoutingJobResult, releaseRoutingJobResult);
  return job;
}
