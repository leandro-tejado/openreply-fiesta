/**
 * Orquesta el fallback de IA: estado de la conversacion -> guardrails -> Claude
 * -> persistencia. Devuelve el texto a enviar, o null si no hay que enviar nada.
 *
 * El worker llama a UNA sola funcion de aca. Todo lo demas vive en lib/ai/,
 * para que el fork siga siendo rebaseable contra upstream.
 */

import { prisma } from "@/lib/db/client";
import { generateReply, isAiGloballyEnabled, type AiTurn } from "./claude";
import {
  evaluateGuardrails,
  isNewDay,
  HISTORY_TURNS,
  type ConversationState,
} from "./guardrails";

export type AiReplyOutcome =
  | { send: true; text: string }
  | { send: false; reason: string };

/**
 * @param instagramAccountId id interno (cuid) de InstagramAccount, no el IGSID.
 * @param inboundAt cuando llego el mensaje del artista (timestamp del job, no
 *   el momento de procesarlo). Es lo que define la ventana de 24h de Meta: un
 *   job reintentado con backoff de 45 minutos puede caer fuera de ella.
 */
export async function buildAiReply(params: {
  workspaceId: string;
  instagramAccountId: string;
  senderId: string;
  messageText: string;
  inboundAt: Date;
  now?: Date;
}): Promise<AiReplyOutcome> {
  const { workspaceId, instagramAccountId, senderId, messageText, inboundAt } =
    params;
  const now = params.now ?? new Date();

  if (!isAiGloballyEnabled()) {
    return { send: false, reason: "ai disabled globally" };
  }

  const existing = await prisma.aiConversation.findUnique({
    where: { instagramAccountId_senderId: { instagramAccountId, senderId } },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: HISTORY_TURNS,
        select: { role: true, content: true },
      },
    },
  });

  const conversation =
    existing ??
    (await prisma.aiConversation.create({
      data: {
        workspaceId,
        instagramAccountId,
        senderId,
        lastInboundAt: inboundAt,
        dayStartedAt: now,
      },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: HISTORY_TURNS,
          select: { role: true, content: true },
        },
      },
    }));

  const state: ConversationState = {
    status: conversation.status,
    messagesToday: conversation.messagesToday,
    dayStartedAt: conversation.dayStartedAt,
    lastInboundAt: inboundAt,
  };

  const decision = evaluateGuardrails(state, messageText, now);

  // El mensaje del artista se guarda pase lo que pase: aunque no le
  // respondamos, es la materia prima para entender que preguntan de verdad.
  await prisma.aiMessage.create({
    data: { conversationId: conversation.id, role: "USER", content: messageText },
  });
  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: { lastInboundAt: inboundAt },
  });

  if (!decision.allow) {
    if (decision.handoff) {
      await prisma.aiConversation.update({
        where: { id: conversation.id },
        data: {
          status: "NEEDS_HUMAN",
          handoffReason: decision.handoffReason ?? null,
        },
      });
    }
    return { send: false, reason: decision.skipReason };
  }

  const history: AiTurn[] = conversation.messages
    .slice()
    .reverse()
    .map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));

  const reply = await generateReply(history, messageText);

  if (reply.refused || !reply.text) {
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { status: "NEEDS_HUMAN", handoffReason: "modelo sin respuesta" },
    });
    return { send: false, reason: "model refused or returned empty" };
  }

  await prisma.aiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: reply.text,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
    },
  });

  const resetCounter = isNewDay(conversation.dayStartedAt, now);
  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: resetCounter
      ? { messagesToday: 1, dayStartedAt: now }
      : { messagesToday: { increment: 1 } },
  });

  return { send: true, text: reply.text };
}
