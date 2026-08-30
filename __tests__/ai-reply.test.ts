import { describe, it, expect } from "vitest";
import {
  evaluateGuardrails,
  detectHandoff,
  isNewDay,
  isWithinMetaWindow,
  stripPriceLeak,
  truncateReply,
  MAX_MESSAGES_PER_DAY,
  META_WINDOW_MS,
  type ConversationState,
} from "@/lib/ai/guardrails";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { SYSTEM_PROMPT, MAX_REPLY_CHARS } from "@/lib/ai/persona";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    status: "ACTIVE",
    messagesToday: 0,
    dayStartedAt: NOW,
    lastInboundAt: NOW,
    ...overrides,
  };
}

describe("ventana de 24h de Meta", () => {
  it("permite responder a un mensaje recien llegado", () => {
    expect(isWithinMetaWindow(NOW, NOW)).toBe(true);
  });

  it("permite responder a las 23 horas", () => {
    const inbound = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
    expect(isWithinMetaWindow(inbound, NOW)).toBe(true);
  });

  it("corta pasadas las 24 horas", () => {
    const inbound = new Date(NOW.getTime() - META_WINDOW_MS - 1000);
    expect(isWithinMetaWindow(inbound, NOW)).toBe(false);
  });

  it("corta dentro del margen de seguridad, antes de que Meta rechace", () => {
    // 23h 58m: tecnicamente dentro, pero sin margen para el envio.
    const inbound = new Date(NOW.getTime() - (META_WINDOW_MS - 2 * 60 * 1000));
    expect(isWithinMetaWindow(inbound, NOW)).toBe(false);
  });

  it("un job reintentado con backoff largo queda fuera y no se envia", () => {
    const inbound = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const decision = evaluateGuardrails(state({ lastInboundAt: inbound }), "hola", NOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.skipReason).toContain("Meta 24h");
      expect(decision.handoff).toBe(false);
    }
  });
});

describe("derivacion a una persona", () => {
  const casos = [
    ["quiero un reembolso ya", "reclamo economico"],
    ["esto es una estafa", "reclamo economico"],
    ["no me llego el acceso", "problema de acceso o pago"],
    ["fallo el pago con la tarjeta", "problema de acceso o pago"],
    ["necesito la factura", "tema administrativo"],
    ["voy a hablar con mi abogado", "tema legal o contractual"],
  ] as const;

  for (const [mensaje, motivo] of casos) {
    it(`deriva "${mensaje}" como ${motivo}`, () => {
      expect(detectHandoff(mensaje)).toBe(motivo);
    });
  }

  it("no deriva una pregunta normal del artista", () => {
    expect(detectHandoff("hago trap, como arranco con los reels?")).toBeNull();
  });

  it("un reclamo no llega al modelo y marca la conversacion", () => {
    const decision = evaluateGuardrails(state(), "quiero mi reembolso", NOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.handoff).toBe(true);
      expect(decision.handoffReason).toBe("reclamo economico");
    }
  });
});

describe("tope diario por artista", () => {
  it("permite mientras esta por debajo del tope", () => {
    const d = evaluateGuardrails(
      state({ messagesToday: MAX_MESSAGES_PER_DAY - 1 }),
      "otra pregunta",
      NOW
    );
    expect(d.allow).toBe(true);
  });

  it("corta al llegar al tope", () => {
    const d = evaluateGuardrails(
      state({ messagesToday: MAX_MESSAGES_PER_DAY }),
      "otra mas",
      NOW
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.skipReason).toContain("daily cap");
  });

  it("un dia nuevo reinicia el contador aunque venga topeado", () => {
    const ayer = new Date("2026-08-29T23:00:00.000Z");
    const d = evaluateGuardrails(
      state({ messagesToday: MAX_MESSAGES_PER_DAY, dayStartedAt: ayer }),
      "hola de nuevo",
      NOW
    );
    expect(d.allow).toBe(true);
  });

  it("isNewDay compara fechas, no 24h moviles", () => {
    expect(isNewDay(new Date("2026-08-29T23:59:00.000Z"), NOW)).toBe(true);
    expect(isNewDay(new Date("2026-08-30T00:01:00.000Z"), NOW)).toBe(false);
  });
});

describe("estados que apagan la IA", () => {
  it("no responde si la conversacion espera a una persona", () => {
    const d = evaluateGuardrails(state({ status: "NEEDS_HUMAN" }), "hola", NOW);
    expect(d.allow).toBe(false);
  });

  it("no responde si esta bloqueada", () => {
    const d = evaluateGuardrails(state({ status: "BLOCKED" }), "hola", NOW);
    expect(d.allow).toBe(false);
  });
});

describe("el precio nunca sale en el DM", () => {
  const fugas = [
    "La academia sale 87 €",
    "son 87 euros pago unico",
    "cuesta $99",
    "te sale USD 100",
    "podes pagarlo en 3 cuotas",
    "son 2000 pesos",
  ];

  for (const fuga of fugas) {
    it(`reemplaza "${fuga}"`, () => {
      const { text, leaked } = stripPriceLeak(fuga);
      expect(leaked).toBe(true);
      expect(text).toContain("academia.fiestamusic.es");
      expect(text).not.toMatch(/\d+\s*(€|euros|\$|usd|pesos|cuotas)/i);
    });
  }

  it("deja pasar una respuesta normal que menciona numeros inofensivos", () => {
    const ok = "Subi 3 reels esta semana y despues me contas como te fue";
    const { text, leaked } = stripPriceLeak(ok);
    expect(leaked).toBe(false);
    expect(text).toBe(ok);
  });
});

describe("largo de la respuesta", () => {
  it("no toca una respuesta corta", () => {
    const corta = "Buenas, aca del equipo de Fiesta. Que genero haces?";
    expect(truncateReply(corta)).toBe(corta);
  });

  it("recorta sin cortar una palabra al medio", () => {
    const larga = "palabra ".repeat(400);
    const out = truncateReply(larga);
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out.endsWith("palabra")).toBe(true);
  });
});

describe("la keyword gana siempre", () => {
  // Replica la decision del worker: si matchKeywords da true, el mensaje lo
  // maneja la campania y NUNCA llega al fallback de IA.
  function llegaALaIa(texto: string, keywords: string[]): boolean {
    return !matchKeywords(texto, keywords, true).matched;
  }

  it("un DM con la keyword exacta no llega a la IA", () => {
    expect(llegaALaIa("LANZAMIENTO", ["LANZAMIENTO"])).toBe(false);
  });

  it("la keyword dentro de una frase tampoco llega a la IA", () => {
    expect(llegaALaIa("hola, LANZAMIENTO porfa", ["LANZAMIENTO"])).toBe(false);
  });

  it("un DM sin keyword si llega a la IA", () => {
    expect(llegaALaIa("che, cuanto sale la academia?", ["LANZAMIENTO"])).toBe(true);
  });

  it("con varias campanias activas, alcanza con que una matchee", () => {
    const keywords = ["GANCHOS", "LISTA", "MARCA", "LANZAMIENTO"];
    expect(llegaALaIa("MARCA", keywords)).toBe(false);
    expect(llegaALaIa("me sirve para mi marca personal?", keywords)).toBe(false);
    expect(llegaALaIa("de que se trata la academia?", keywords)).toBe(true);
  });
});

describe("el prompt no se desvia de la marca", () => {
  it("prohibe explicitamente decir el precio", () => {
    expect(SYSTEM_PROMPT).toMatch(/NUNCA decis el precio/);
  });

  it("exige voseo y prohibe el tuteo", () => {
    expect(SYSTEM_PROMPT).toMatch(/[Vv]oseo argentino/);
    expect(SYSTEM_PROMPT).toMatch(/Nunca "tu"/);
  });

  it("fija la presentacion acordada", () => {
    expect(SYSTEM_PROMPT).toContain("Buenas, aca del equipo de Fiesta");
  });

  it("prohibe el anglicismo que borra el acento de la marca", () => {
    expect(SYSTEM_PROMPT).toMatch(/[Nn]unca digas "release"/);
  });

  it("prohibe prometer resultados", () => {
    expect(SYSTEM_PROMPT).toMatch(/NUNCA prometes resultados/);
  });
});
