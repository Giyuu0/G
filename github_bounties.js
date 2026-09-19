// ---------------------------------------------------------------------------
// Discovery Agent 1: code bounties (GitHub issues labeled as bounties, incl.
// Algora-run repos). Uses the public GitHub Search API — no key required for
// low volume, but set GITHUB_TOKEN to raise the rate limit.
// ---------------------------------------------------------------------------

const SEARCH_TERMS = [
  'label:"bounty" state:open',
  'label:"algora-bounty" state:open',
  '"$" bounty in:title state:open type:issue',
];

function hashId(source, externalId) {
  // Deterministic short id so re-discovery doesn't duplicate rows.
  let h = 0;
  const s = `${source}:${externalId}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `gh_${(h >>> 0).toString(36)}`;
}

function extractRewardText(text) {
  const match = (text || "").match(/\$\s?\d[\d,]*(\.\d+)?/);
  return match ? match[0] : null;
}

export async function discoverGithubBounties(env) {
  const headers = {
    "User-Agent": "atria-earning-system",
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const found = [];
  for (const term of SEARCH_TERMS) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(
      term
    )}&sort=created&order=desc&per_page=25`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // Don't throw on one bad query — log and continue with the rest.
      console.log("github search failed", term, res.status);
      continue;
    }
    const data = await res.json();
    for (const issue of data.items || []) {
      const ageHours =
        (Date.now() - new Date(issue.created_at).getTime()) / 36e5;
      found.push({
        id: hashId("github", issue.id),
        category: "code_bounty",
        source: "github",
        title: issue.title,
        url: issue.html_url,
        description: (issue.body || "").slice(0, 2000),
        reward_text: extractRewardText(issue.title + " " + (issue.body || "")),
        discovered_at: new Date().toISOString(),
        age_hours: ageHours,
        // comments count is our stand-in "competition signal": more comments
        // usually means more competing submissions already in flight.
        competition_signal: issue.comments,
      });
    }
  }
  return found;
}
