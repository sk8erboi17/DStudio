// Intentionally not part of check-fast. This runner is an explicit guardrail:
// real-model A/B execution must be requested by a human with RUN_HEAVY=1.
if (process.env.RUN_HEAVY !== '1') {
  console.error('Task Graph heavy benchmarks are prepared but disabled. Set RUN_HEAVY=1 explicitly.');
  process.exit(2);
}
console.error('Heavy runner scaffold is ready; connect approved fixture/model launch orchestration before release gating.');
process.exit(2);
