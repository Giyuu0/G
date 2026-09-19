// ---------------------------------------------------------------------------
// Token Treasury Agent (v2) — the only agent allowed to authorize an Atria
// call, now across THREE separate Atria accounts (300M tokens combined).
//
// Policy (manager + quality agent decision, as agreed):
//   - high-score opportunity   -> full cap (4000 tokens)
//   - medium-score opportunity -> reduced cap (1500 tokens)
//   - low-score opportunity    -> rejected, zero tokens spent
//   - an account under its 5% reserve is skipped in favor of another
//     account that still has headroom; only once ALL THREE are low does
//     the treasury freeze and alert the human
//
// Picking "the account with the most remaining balance" for each call also
// spreads load across three independent per-minute rate limits, which
// roughly triples real throughput compared to a single account.
// ---------------------------------------------------------------------------

const FULL_CAP_TOKENS = 4000;
const REDUCED_CAP_TOKENS = 1500;
const HIGH_SCORE_THRESHOLD = 15;
const MEDIUM_SCORE_THRESHOLD = 10;
const LOW_BALANCE_RESERVE_RATIO = 0.05; // skip/freeze once <5% of an account remains

async function getAccounts(db) {
  const rows = await db.prepare("SELECT * FROM token_accounts").all();
  return rows.results || [];
}

function remainingOf(account) {
  return account.total_tokens - account.used_tokens - account.reserved_tokens;
}

function isAboveReserve(account) {
  if (account.total_tokens <= 0) return false;
  return remainingOf(account) > account.total_tokens * LOW_BALANCE_RESERVE_RATIO;
}

export async function getTotalRemainingTokens(db) {
  const accounts = await getAccounts(db);
  return accounts.reduce((sum, a) => sum + remainingOf(a), 0);
}

async function logDecision(db, { opportunityId, agentName, accountKey, decision, reason, allocatedMaxTokens }) {
  await db
    .prepare(
      `INSERT INTO token_ledger (opportunity_id, agent_name, account_key, decision, reason, allocated_max_tokens)
       VALUES (?,?,?,?,?,?)`
    )
    .bind(opportunityId, agentName, accountKey || null, decision, reason || null, allocatedMaxTokens || null)
    .run();
}

// Called by an execution agent BEFORE it calls callBrain().
// Returns { approved, maxTokens, accountKey, reason }
// accountKey is the NAME of the Worker secret to use (e.g. "ATRIA_API_KEY_2"),
// so the caller does `env[allocation.accountKey]` to get the real key value.
export async function requestAllocation(db, { opportunity, agentName }) {
  const accounts = await getAccounts(db);
  const initialized = accounts.filter((a) => a.total_tokens > 0);

  if (initialized.length === 0) {
    await logDecision(db, {
      opportunityId: opportunity.id,
      agentName,
      decision: "rejected",
      reason: "No Atria account has total_tokens set yet — run the schema init step.",
    });
    return { approved: false, maxTokens: 0, reason: "treasury_not_initialized" };
  }

  const score = opportunity.score ?? 0;
  let maxTokens = 0;
  if (score >= HIGH_SCORE_THRESHOLD) maxTokens = FULL_CAP_TOKENS;
  else if (score >= MEDIUM_SCORE_THRESHOLD) maxTokens = REDUCED_CAP_TOKENS;

  if (maxTokens === 0) {
    await logDecision(db, {
      opportunityId: opportunity.id,
      agentName,
      decision: "rejected",
      reason: `score ${score} below minimum threshold ${MEDIUM_SCORE_THRESHOLD}`,
    });
    return { approved: false, maxTokens: 0, reason: "score_too_low" };
  }

  const candidates = initialized
    .filter((a) => isAboveReserve(a) && remainingOf(a) >= maxTokens)
    .sort((a, b) => remainingOf(b) - remainingOf(a));

  if (candidates.length === 0) {
    await logDecision(db, {
      opportunityId: opportunity.id,
      agentName,
      decision: "budget_frozen",
      reason: "All 3 Atria accounts are at or below their 5% reserve floor",
    });
    return { approved: false, maxTokens: 0, reason: "budget_frozen" };
  }

  const chosen = candidates[0];

  await db
    .prepare(
      "UPDATE token_accounts SET reserved_tokens = reserved_tokens + ?, last_used_at = datetime('now') WHERE account_key = ?"
    )
    .bind(maxTokens, chosen.account_key)
    .run();

  await logDecision(db, {
    opportunityId: opportunity.id,
    agentName,
    accountKey: chosen.account_key,
    decision: "approved",
    reason: `score ${score}, account ${chosen.account_key} had most headroom`,
    allocatedMaxTokens: maxTokens,
  });

  return { approved: true, maxTokens, accountKey: chosen.account_key, reason: "approved" };
}

// Called AFTER the Atria call completes, with real usage numbers.
export async function reconcileUsage(db, { opportunity, accountKey, reservedMaxTokens, promptTokens, completionTokens }) {
  const actualTotal = (promptTokens || 0) + (completionTokens || 0);
  await db
    .prepare(
      `UPDATE token_accounts
       SET used_tokens = used_tokens + ?,
           reserved_tokens = MAX(0, reserved_tokens - ?)
       WHERE account_key = ?`
    )
    .bind(actualTotal, reservedMaxTokens, accountKey)
    .run();

  await db
    .prepare(
      `UPDATE token_ledger
       SET actual_prompt_tokens = ?, actual_completion_tokens = ?
       WHERE opportunity_id = ? AND account_key = ? AND decision = 'approved'
       ORDER BY id DESC LIMIT 1`
    )
    .bind(promptTokens || 0, completionTokens || 0, opportunity.id, accountKey)
    .run();
}

// If a reserved allocation is never used (e.g. the call throws), release it.
export async function releaseReservation(db, accountKey, maxTokens) {
  await db
    .prepare(
      "UPDATE token_accounts SET reserved_tokens = MAX(0, reserved_tokens - ?) WHERE account_key = ?"
    )
    .bind(maxTokens, accountKey)
    .run();
}

// Checked once per cron cycle (see index.js). Alerts once when ALL accounts
// drop under reserve, and resets so it can alert again after a top-up.
export async function shouldAlertLowBalance(db) {
  const accounts = await getAccounts(db);
  const initialized = accounts.filter((a) => a.total_tokens > 0);
  if (initialized.length === 0) return false;

  const allLow = initialized.every((a) => !isAboveReserve(a));
  const anyAlertFlag = initialized.some((a) => a.low_balance_alert_sent);

  if (allLow && !anyAlertFlag) {
    await db.prepare("UPDATE token_accounts SET low_balance_alert_sent = 1").run();
    return true;
  }
  if (!allLow && anyAlertFlag) {
    await db.prepare("UPDATE token_accounts SET low_balance_alert_sent = 0").run();
  }
  return false;
}

export async function getAccountsSummary(db) {
  const accounts = await getAccounts(db);
  return accounts.map((a) => ({
    account: a.account_key,
    remaining: remainingOf(a),
    total: a.total_tokens,
    used: a.used_tokens,
  }));
}
