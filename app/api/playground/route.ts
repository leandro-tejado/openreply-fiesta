/**
 * Chat de prueba contra el prompt real.
 *
 * Usa exactamente el mismo lib/ai/claude.ts que el worker, pero NO persiste en
 * AiConversation ni envia nada por Meta. Sirve para ajustar el tono en segundos
 * en vez de dias, y sin quemar la ventana de 24h de una conversacion real.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  generateReply,
  isAiGloballyEnabled,
  MissingAnthropicKeyError,
  type AiTurn,
} from "@/lib/ai/claude";
import { detectHandoff } from "@/lib/ai/guardrails";

const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .max(24)
    .optional()
    .default([]),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAiGloballyEnabled()) {
    return NextResponse.json(
      { error: "La IA esta apagada (AI_REPLIES_ENABLED=false)." },
      { status: 409 }
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { message, history } = parsed.data;

  // Se avisa, pero no se corta: en el playground interesa VER que la derivacion
  // se dispararia, sin perder la posibilidad de seguir probando el prompt.
  const handoffReason = detectHandoff(message);

  try {
    const reply = await generateReply(history as AiTurn[], message);
    return NextResponse.json({
      text: reply.text,
      refused: reply.refused,
      priceLeaked: reply.priceLeaked,
      handoffReason,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
    });
  } catch (error) {
    if (error instanceof MissingAnthropicKeyError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
