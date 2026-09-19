// ---------------------------------------------------------------------------
// Telegram bot integration — the single control/notification channel.
// ---------------------------------------------------------------------------

export async function tgSend(env, text, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...options,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

// Sends a notification with inline "approve / reject" style buttons.
// callback_data is read back in the webhook handler in index.js.
export async function tgSendWithButtons(env, text, buttons) {
  // buttons: [{ text: "✅ Approve", data: "approve:123" }, ...]
  return tgSend(env, text, {
    reply_markup: {
      inline_keyboard: [
        buttons.map((b) => ({ text: b.text, callback_data: b.data })),
      ],
    },
  });
}

export function formatOpportunityNotice(opp) {
  return (
    `🟡 <b>New opportunity</b>\n` +
    `Category: ${opp.category}\n` +
    `Title: ${opp.title}\n` +
    `Reward: ${opp.reward_text || "unknown"}\n` +
    `Score: ${opp.score ?? "n/a"}\n` +
    `<a href="${opp.url}">Open</a>`
  );
}

export function formatHumanNeeded(opp) {
  return (
    `🔴 <b>Needs your action</b>\n` +
    `Title: ${opp.title}\n` +
    `Reason: ${opp.needs_human_reason}\n` +
    `<a href="${opp.url}">Open</a>`
  );
}

export function formatDailyReport({ discovered, executed, needsHuman, errors }) {
  return (
    `📊 <b>Daily report</b>\n` +
    `Discovered: ${discovered}\n` +
    `Executed: ${executed}\n` +
    `Needs your action: ${needsHuman}\n` +
    `Agent errors: ${errors}`
  );
}
