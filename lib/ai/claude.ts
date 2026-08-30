/**
 * La llamada a Claude. Un solo lugar, para que el worker y el playground
 * compartan exactamente el mismo prompt y los mismos limites.
 */

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./persona";
import { stripPriceLeak, truncateReply } from "./guardrails";

/**
 * Haiku 4.5 por decision del 30-08-2026: el bot entrega un link, responde dudas
 * del contenido y hace una pregunta de calificacion. Lo que impide que diga un
 * precio o invente modulos no es la inteligencia del modelo sino el guardrail
 * deterministico, que anda igual con cualquiera.
 *
 * Se cambia con AI_MODEL sin tocar codigo. Ojo: los parametros NO son los
 * mismos entre familias (ver supportsAdaptiveThinking).
 */
const MODEL = process.env.AI_MODEL ?? "claude-haiku-4-5";

const MAX_TOKENS = 1000;

/**
 * `thinking: adaptive` y `output_config.effort` existen desde la familia 4.6.
 * Mandarselos a Haiku 4.5 devuelve 400. Este switch es lo que permite probar
 * varios modelos con AI_MODEL sin que reviente la llamada.
 */
function supportsAdaptiveThinking(model: string): boolean {
  return (
    model.startsWith("claude-opus-5") ||
    model.startsWith("claude-opus-4-6") ||
    model.startsWith("claude-opus-4-7") ||
    model.startsWith("claude-opus-4-8") ||
    model.startsWith("claude-sonnet-5") ||
    model.startsWith("claude-sonnet-4-6") ||
    model.startsWith("claude-fable-5")
  );
}

const EFFORT = (process.env.AI_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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

export function activeModel(): string {
  return MODEL;
}

/**
 * Genera la respuesta al DM. No persiste nada ni envia nada: eso lo hace quien
 * la llama, para que el playground pueda usarla sin tocar Instagram.
 */
export async function generateReply(
  history: AiTurn[],
  userMessage: string
): Promise<AiReply> {
  const messages = [...history, { role: "user" as const, content: userMessage }];

  // El system es estable entre llamadas, asi que se marca para cachear. Aviso:
  // el prompt ronda los 900 tokens y el minimo cacheable depende del modelo, asi
  // que puede no llegar a cachear nunca. Ademas el TTL es de 5 minutos y una
  // charla por DM es lenta. No contar con ese ahorro.
  const system = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const response = supportsAdaptiveThinking(MODEL)
    ? await getClient().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        system,
        messages,
      })
    : await getClient().messages.create({
        // Haiku 4.5 y anteriores: sin thinking y sin effort, los rechazan.
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages,
      });

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  // Siempre antes de leer content: en refusal viene vacio o inutil.
  if (response.stop_reason === "refusal") {
    return {
      text: "",
      inputTokens,
      outputTokens,
      refused: true,
      priceLeaked: false,
    };
  }

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!raw) {
    return {
      text: "",
      inputTokens,
      outputTokens,
      refused: true,
      priceLeaked: false,
    };
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

// Exportado solo para tests.
export const __testing = { supportsAdaptiveThinking };
