/**
 * Prende y apaga el asistente de IA por cuenta de Instagram.
 *
 * Es el interruptor fino. El grueso es la variable de entorno
 * AI_REPLIES_ENABLED=false, que apaga la IA en todas las cuentas de golpe sin
 * tocar el keyword->DM, que sigue funcionando igual.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

const bodySchema = z.object({
  instagramAccountId: z.string().min(1),
  aiEnabled: z.boolean(),
});

export async function POST(request: Request) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid body" },
      { status: 400 }
    );
  }

  const { instagramAccountId, aiEnabled } = parsed.data;

  // El workspaceId va en el where, no en un chequeo aparte: asi una cuenta de
  // otro workspace no se puede togglear ni conociendo su id.
  const result = await prisma.instagramAccount.updateMany({
    where: { id: instagramAccountId, workspaceId },
    data: { aiEnabled },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, data: { aiEnabled } });
}
