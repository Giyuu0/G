import { discoverGithubBounties } from "./github_bounties.js";
import { scoreOpportunity } from "./scoring.js";
import { draftBountyFix } from "./github_bounty_execution.js";
import {
  tgSend,
  tgSendWithButtons,
  formatOpportunityNotice,
  formatHumanNeeded,
  formatDailyReport,
} from "./telegram.js";
import { getTotalRemainingTokens, shouldAlertLowBalance, getAccountsSummary } from "./treasury.js";

// ---------------------------------------------------------------------------
// Manager agent: orchestrates discovery -> scoring -> execution -> notify.
// Kept as plain functions (not classes) — simplest thing that works on
// Workers; split into more files as more categories are added.
// ---------------------------------------------------------------------------

const SCORE_THRESHOLD_FOR_EXECUTION = 10; // tune once you see real data
const MIN_SCORE_TO_NOTIFY = 0; // notify about anything that clears scoring at all

async function upsertOpportunity(db, opp) {
  const existing = await db
    .prepare("SELECT id, status FROM opportunities WHERE id = ?")
    .bind(opp.id)
    .first();
  if (existing) return { opp, isNew: false, status: existing.status };

  await db
    .prepare(
      `INSERT INTO opportunities
       (id, category, source, title, url, description, reward_text, reward_value,
        discovered_at, age_hours, competition_signal, score, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'discovered')`
    )
    .bind(
      opp.id,
      opp.category,
      opp.source,
      opp.title,
      opp.url,
      opp.description || "",
      opp.reward_text,
      opp.score ?? null,
      opp.discovered_at,
      opp.age_hours,
      opp.competition_signal ?? null,
      opp.score ?? null
    )
    .run();
  return { opp, isNew: true, status: "discovered" };
}

async function setStatus(db, id, status, extra = {}) {
  const fields = ["status = ?", "updated_at = datetime('now')"];
  const values = [status];
  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  await db
    .prepare(`UPDATE opportunities SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

async function recordAgentRun(db, name, status, error = null) {
  await db
    .prepare(
      `INSERT INTO agent_health (agent_name, last_run_at, last_status, last_error, run_count)
       VALUES (?, datetime('now'), ?, ?, 1)
       ON CONFLICT(agent_name) DO UPDATE SET
         last_run_at = datetime('now'),
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         run_count = agent_health.run_count + 1`
    )
    .bind(name, status, error)
    .run();
}

// ---------------------------------------------------------------------------
// The main scan cycle: run every discovery agent, score, decide, execute.
// ---------------------------------------------------------------------------
async function runFullCycle(env) {
  const db = env.DB;
  let discoveredCount = 0;
  let executedCount = 0;
  let needsHumanCount = 0;
  let errorCount = 0;

  // --- Discovery ---------------------------------------------------------
  let githubOpps = [];
  try {
    githubOpps = await discoverGithubBounties(env);
    await recordAgentRun(db, "discovery_github_bounties", "ok");
  } catch (e) {
    errorCount++;
    await recordAgentRun(db, "discovery_github_bounties", "error", String(e));
  }

  const allNew = [];
  for (const opp of githubOpps) {
    opp.score = scoreOpportunity(opp);
    const { isNew } = await upsertOpportunity(db, opp);
    if (isNew) {
      discoveredCount++;
      allNew.push(opp);
    }
  }

  // --- Notify about newly discovered opportunities ------------------------
  for (const opp of allNew) {
    if (opp.score >= MIN_SCORE_TO_NOTIFY) {
      await tgSend(env, formatOpportunityNotice(opp));
    }
  }

  // --- Execution: only for opportunities that clear the score bar --------
  const toExecute = allNew.filter((o) => o.score >= SCORE_THRESHOLD_FOR_EXECUTION);
  for (const opp of toExecute) {
    try {
      await setStatus(db, opp.id, "executing");
      const { output, needsHuman, reason } = await draftBountyFix(env, opp);
      if (needsHuman) {
        needsHumanCount++;
        await setStatus(db, opp.id, "needs_human", {
          needs_human_reason: reason,
        });
        await tgSend(env, formatHumanNeeded({ ...opp, needs_human_reason: reason }));
      } else {
        executedCount++;
        await setStatus(db, opp.id, "submitted", { execution_output: output });
        await tgSendWithButtons(
          env,
          `✅ Draft ready for: <b>${opp.title}</b>\n<a href="${opp.url}">Open issue</a>\n\nReview the draft in D1 (opportunities.execution_output) before posting the PR.`,
          [{ text: "Mark as posted", data: `posted:${opp.id}` }]
        );
      }
      await recordAgentRun(db, "execution_github_bounty", "ok");
    } catch (e) {
      errorCount++;
      await setStatus(db, opp.id, "discovered"); // reset so it can retry next cycle
      await recordAgentRun(db, "execution_github_bounty", "error", String(e));
    }
  }

  // --- Treasury health check (once per cycle) -----------------------------
  if (await shouldAlertLowBalance(db)) {
    await tgSend(
      env,
      `🔴 <b>Token budget critical</b>\nAll 3 Atria accounts are near/at their reserve floor. New executions are paused until you top up or approve continuing.`
    );
  }

  return { discoveredCount, executedCount, needsHumanCount, errorCount };
}

// ---------------------------------------------------------------------------
// Telegram webhook: handles button presses and simple commands.
// ---------------------------------------------------------------------------
async function handleTelegramWebhook(request, env) {
  const update = await request.json().catch(() => ({}));

  if (update.callback_query) {
    const data = update.callback_query.data || "";
    if (data.startsWith("posted:")) {
      const id = data.split(":")[1];
      await env.DB.prepare(
        "UPDATE opportunities SET status = 'paid_pending', updated_at = datetime('now') WHERE id = ?"
      )
        .bind(id)
        .run();
      await tgSend(env, `Marked ${id} as posted. Tracking for payment.`);
    }
    return new Response("ok");
  }

  const text = update.message?.text?.trim();
  if (text === "/scan") {
    const result = await runFullCycle(env);
    await tgSend(
      env,
      `Manual scan done. Discovered: ${result.discoveredCount}, Executed: ${result.executedCount}`
    );
  } else if (text === "/status") {
    const rows = await env.DB.prepare(
      "SELECT status, COUNT(*) as c FROM opportunities GROUP BY status"
    ).all();
    const lines = rows.results.map((r) => `${r.status}: ${r.c}`).join("\n");
    await tgSend(env, `<b>Status</b>\n${lines || "no data yet"}`);
  } else if (text === "/balance") {
    const summary = await getAccountsSummary(env.DB);
    const lines = summary
      .map((a) => `${a.account}: ${a.remaining.toLocaleString()} / ${a.total.toLocaleString()} remaining`)
      .join("\n");
    const total = await getTotalRemainingTokens(env.DB);
    await tgSend(env, `<b>Token balance</b>\n${lines}\n\nTotal remaining: ${total.toLocaleString()}`);
  }

  return new Response("ok");
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", time: new Date().toISOString() });
    }

    if (url.pathname === "/api/scan" && request.method === "POST") {
      const auth = request.headers.get("Authorization");
      if (env.ADMIN_SECRET && auth !== `Bearer ${env.ADMIN_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const result = await runFullCycle(env);
      return Response.json(result);
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    return new Response("atria-earning-system: see /api/health", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFullCycle(env));
  },
};
