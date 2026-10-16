/** Leave time for approval to finish before the selected database-clock minute. */
export function scheduledReviewFixtureWake(now: number): number {
  return Math.ceil((now + 10000) / 60000) * 60000;
}
