// ---------------------------------------------------------------------------
// Shared AI "brain" call — wraps the Atria Dawn Preview model (OpenAI-compatible
// chat/completions endpoint). Kept in one place on purpose: swapping to a
// different model/provider later means editing only this file.
// ---------------------------------------------------------------------------

const ATRIA_URL = "https://api.atria-asi.ai/v1/chat/completions";
const MODEL_ID = "Atria-Dawn-Preview";

// Simple in-memory-per-request rate awareness. Cloudflare Workers are
// stateless between requests, so real throttling must live in the manager
// agent's queue (D1-based), not here — this is just a single safe call.
export async function callBrain(env, { apiKey, system, prompt, maxTokens = 2000 }) {
  if (!apiKey) {
    throw new Error("No Atria API key provided to callBrain (Treasury must supply one)");
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await fetch(ATRIA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(`ATRIA_RATE_LIMITED retry_after=${retryAfter}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Atria API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// Fallback to Cloudflare Workers AI (free, on-platform) for cheap
// classification/filtering tasks that don't need Atria's reasoning depth.
export async function callCheapModel(env, prompt) {
  if (!env.AI) throw new Error("Workers AI binding not configured");
  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
  return result.response ?? "";
}
