// ---------------------------------------------------------------------------
// Scoring agent — pure logic, no AI call needed. Implements the "stale
// competition = higher priority" rule we settled on during planning.
// ---------------------------------------------------------------------------

export function parseRewardValue(rewardText) {
  if (!rewardText) return null;
  const cleaned = rewardText.replace(/[^0-9.]/g, "");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function scoreOpportunity(opp) {
  const reward = parseRewardValue(opp.reward_text) ?? 0;
  const competition = opp.competition_signal ?? 0;
  const ageHours = opp.age_hours ?? 0;

  // Stale (>48h) + low competition (<3 comments) => competition is likely
  // dead, so bump priority even if the reward is modest.
  const staleBonus = ageHours > 48 && competition < 3 ? 25 : 0;

  // Heavy early competition on a fresh item => very low odds, penalize hard.
  const freshCrowdPenalty = ageHours < 6 && competition > 5 ? -20 : 0;

  const rewardScore = Math.min(reward, 500) / 10; // caps influence of huge rewards
  const competitionPenalty = Math.min(competition * 2, 30);

  const score =
    rewardScore - competitionPenalty + staleBonus + freshCrowdPenalty;

  return Math.round(score * 100) / 100;
}
