// ---------------------------------------------------------------------------
// Execution Agent 1: produces an actual proposed fix/diff for a code bounty
// using the Atria model. This MVP stops at "draft" and asks for one human
// confirmation before anything is posted publicly as a PR/comment — safer
// starting point; full auto-submission can be turned on later once you've
// reviewed a batch of drafts and trust the output quality.
// ---------------------------------------------------------------------------

import { callBrain } from "./atria.js";
import { requestAllocation, reconcileUsage, releaseReservation } from "./treasury.js";

const SYSTEM_PROMPT = `You are a careful software engineer completing a paid
GitHub issue bounty. Read the issue description and propose a concrete,
minimal, correct fix. Output format strictly:

## Summary
<one paragraph>

## Proposed patch
<code diff or full file content, in a fenced code block>

## PR description draft
<ready-to-paste PR description text>

If the issue is too vague to solve confidently, say so explicitly instead of
guessing, and list exactly what information is missing.`;

export async function draftBountyFix(env, opportunity) {
  const db = env.DB;

  // Ask the Treasury for permission before spending a single token.
  const allocation = await requestAllocation(db, {
    opportunity,
    agentName: "execution_github_bounty",
  });

  if (!allocation.approved) {
    return {
      output: null,
      needsHuman: allocation.reason === "budget_frozen",
      reason:
        allocation.reason === "budget_frozen"
          ? "Token budget is below the safety reserve — needs your decision on whether to top up or wait"
          : `Treasury declined this task (${allocation.reason})`,
      treasuryDeclined: true,
    };
  }

  const prompt = `Issue title: ${opportunity.title}\nIssue URL: ${opportunity.url}\n\nIssue body:\n${opportunity.description || "(no description)"}`;

  let result;
  try {
    result = await callBrain(env, {
      apiKey: env[allocation.accountKey],
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: allocation.maxTokens,
    });
  } catch (e) {
    await releaseReservation(db, allocation.accountKey, allocation.maxTokens);
    throw e;
  }

  await reconcileUsage(db, {
    opportunity,
    accountKey: allocation.accountKey,
    reservedMaxTokens: allocation.maxTokens,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  });

  const tooVague = /too vague|missing information|cannot solve confidently/i.test(
    result.text
  );

  return {
    output: result.text,
    needsHuman: tooVague,
    reason: tooVague ? "Model could not confidently solve the issue from the description alone" : null,
  };
}
