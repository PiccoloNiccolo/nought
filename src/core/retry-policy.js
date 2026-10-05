// Respect both Retry-After formats; repeated failures back off instead of retrying
// every ten seconds forever. Jitter prevents clients from waking in lockstep.
export function retryDelay(attempt, retryAfter, now = Date.now(), random = Math.random) {
  const seconds = Number(retryAfter);
  const server = retryAfter == null ? 0 : Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now) || 0;
  const exponential = Math.min(120000, 10000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));
  return Math.max(server, Math.round(exponential * (1 + random() * 0.2)));
}
