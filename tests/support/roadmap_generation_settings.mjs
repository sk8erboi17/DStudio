// Learn defaults to High; explicit user choices remain selectable. A launch default is not a per-call
// setting: explicit diagnostic overrides must reach the generation request.
export function roadmapGenerationSettings(env = process.env) {
  const thinkLevel = env.DSTUDIO_REAL_ROADMAP_THINK_LEVEL || 'high';
  if (!['off', 'low', 'medium', 'high', 'max'].includes(thinkLevel))
    throw new Error('DSTUDIO_REAL_ROADMAP_THINK_LEVEL must be off, low, medium, high or max');
  return {thinkLevel};
}
