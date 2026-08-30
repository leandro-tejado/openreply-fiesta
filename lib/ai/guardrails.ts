/**
 * Todo lo que corta ANTES de llamar a Claude, y el unico chequeo que corre
 * despues (la fuga de precio).
 *
 * Regla de oro: si algo se puede decidir sin gastar un token, se decide aca.
 */

import {
  HANDOFF_PATTERNS,
  PRICE_LEAK_PATTERNS,
  ACADEMIA_URL,
  MAX_REPLY_CHARS,
} from "./persona";

/** Ventana de mensajeria de Meta: 24h desde el ultimo mensaje del usuario. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Margen de seguridad: no arriesgamos un envio en los ultimos 5 minutos. */
const WINDOW_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/** Tope de respuestas de IA por artista y por dia. Frena el abuso y el gasto. */
export const MAX_MESSAGES_PER_DAY = 20;

/** Cuantos turnos previos se le mandan al modelo. */
export const HISTORY_TURNS = 12;

export type GuardrailDecision =
  | { allow: true }
  | { allow: false; skipReason: string; handoff: boolean; handoffReason?: string };

export type ConversationState = {
  status: "ACTIVE" | "NEEDS_HUMAN" | "BLOCKED";
  messagesToday: number;
  dayStartedAt: Date;
  lastInboundAt: Date;
};

/** Un dia nuevo reinicia el contador. Se compara por fecha, no por 24h moviles. */
export function isNewDay(dayStartedAt: Date, now: Date): boolean {
  return (
    dayStartedAt.getUTCFullYear() !== now.getUTCFullYear() ||
    dayStartedAt.getUTCMonth() !== now.getUTCMonth() ||
    dayStartedAt.getUTCDate() !== now.getUTCDate()
  );
}

/**
 * Meta rechaza el envio pasadas 24h desde el ultimo mensaje del artista. No es
 * un error nuestro y no se reintenta: se registra y se corta.
 */
export function isWithinMetaWindow(lastInboundAt: Date, now: Date): boolean {
  return (
    now.getTime() - lastInboundAt.getTime() <
    META_WINDOW_MS - WINDOW_SAFETY_MARGIN_MS
  );
}

/** Detecta si el mensaje entrante debe ir directo a una persona. */
export function detectHandoff(messageText: string): string | null {
  for (const { pattern, reason } of HANDOFF_PATTERNS) {
    if (pattern.test(messageText)) return reason;
  }
  return null;
}

/**
 * Decide si el mensaje llega a Claude. Se corre SIEMPRE antes de la llamada.
 */
export function evaluateGuardrails(
  state: ConversationState,
  messageText: string,
  now: Date = new Date()
): GuardrailDecision {
  if (state.status === "BLOCKED") {
    return { allow: false, skipReason: "conversation blocked", handoff: false };
  }

  if (state.status === "NEEDS_HUMAN") {
    return {
      allow: false,
      skipReason: "waiting for human handoff",
      handoff: false,
    };
  }

  const handoffReason = detectHandoff(messageText);
  if (handoffReason) {
    return {
      allow: false,
      skipReason: `handoff: ${handoffReason}`,
      handoff: true,
      handoffReason,
    };
  }

  if (!isWithinMetaWindow(state.lastInboundAt, now)) {
    return {
      allow: false,
      skipReason: "outside Meta 24h messaging window",
      handoff: false,
    };
  }

  const countToday = isNewDay(state.dayStartedAt, now) ? 0 : state.messagesToday;
  if (countToday >= MAX_MESSAGES_PER_DAY) {
    return {
      allow: false,
      skipReason: `daily cap reached (${MAX_MESSAGES_PER_DAY})`,
      handoff: false,
    };
  }

  return { allow: true };
}

/**
 * Ultima linea de defensa: si el modelo dejo escapar un precio pese al prompt,
 * la respuesta se reemplaza por la derivacion a la landing. Preferimos un
 * mensaje generico a uno que invente condiciones comerciales.
 */
export function stripPriceLeak(reply: string): {
  text: string;
  leaked: boolean;
} {
  const leaked = PRICE_LEAK_PATTERNS.some((p) => p.test(reply));
  if (!leaked) return { text: reply, leaked: false };
  return {
    text: `Eso lo ves mejor en la landing, ahi esta todo el detalle: ${ACADEMIA_URL}`,
    leaked: true,
  };
}

/**
 * Recorta sin cortar una palabra al medio. Un DM largo no se lee.
 */
export function truncateReply(
  reply: string,
  max: number = MAX_REPLY_CHARS
): string {
  const text = reply.trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastBreak = Math.max(
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" ")
  );
  return (lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice).trim();
}
