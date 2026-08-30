/**
 * La llamada a Claude. Un solo lugar, para que el worker y el playground
 * compartan exactamente el mismo prompt y los mismos limites.
 */

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./persona";
import { stripPriceLeak, truncateReply } from "./guardrails";

const MODEL = "claude-opus-5";

/**
 * `low` porque esto es un DM de atencion: respuestas cortas, latencia baja y
 * volumen alto. Lo que de verdad protege contra la alucinacion comercial no es
 * el effort sino el guardrail deterministico de precio.
 * Se sube por env sin tocar codigo si el tono lo pide.
 */
const EFFORT = (process.env.AI_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const MAX_TOKENS = 1000;

export type AiTurn = { role: "user" | "assistant"; content: string };

export type AiReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** El modelo se nego a responder. No se envia nada y se deriva a una persona. */
  refused: boolean;
  /** El guardrail tuvo que reemplazar la respuesta por la derivacion. */
  priceLeaked: boolean;
};

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY no esta configurada. La capa de IA no puede responder."
    );
    this.name = "MissingAnthropicKeyError";
  }
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new MissingAnthropicKeyError();
  if (!client) client = new Anthropic();
  return client;
}

/** Kill switch global. Independiente del toggle por cuenta. */
export function isAiGloballyEnabled(): boolean {
  return process.env.AI_REPLIES_ENABLED !== "false";
}

/**
 * Genera la respuesta al DM. No persiste nada ni envia nada: eso lo hace quien
 * la llama, para que el playground pueda usarla sin tocar Instagram.
 */
export async function generateReply(
  history: AiTurn[],
  userMessage: string
): Promise<AiReply> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    // El system es estable entre llamadas: se cachea para no pagarlo cada vez.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [...history, { role: "user" as const, content: userMessage }],
  });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  // Siempre antes de leer content: en refusal viene vacio o inutil.
  if (response.stop_reason === "refusal") {
    return { text: "", inputTokens, outputTokens, refused: true, priceLeaked: false };
  }

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!raw) {
    return { text: "", inputTokens, outputTokens, refused: true, priceLeaked: false };
  }

  const { text, leaked } = stripPriceLeak(raw);

  return {
    text: truncateReply(text),
    inputTokens,
    outputTokens,
    refused: false,
    priceLeaked: leaked,
  };
}
