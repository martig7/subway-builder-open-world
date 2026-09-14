// The native tile and cross-city evaluators share one allocation slot. Await
// host fare callbacks inside the slot so a partially prepared job still counts.
let tail = Promise.resolve();
export function runRoutingJob(operation) {
  const job = tail.then(operation);
  tail = job.catch(() => {});
  return job;
}
