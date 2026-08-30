"use client";

/**
 * Playground
 *
 * Chat contra el prompt real del asistente, sin pasar por Instagram y sin
 * persistir nada. Es donde se ajusta el tono: iterar aca cuesta segundos,
 * iterar por DM cuesta dias y quema la ventana de 24h.
 */

import { useEffect, useRef, useState } from "react";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Flags {
  priceLeaked?: boolean;
  handoffReason?: string | null;
  refused?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

const PRUEBAS = [
  "cuanto sale la academia?",
  "es muy caro para mi",
  "hago trap, hace 2 meses que subo reels y no pasa nada",
  "quiero que me devuelvan la plata",
  "de que se trata esto?",
];

export default function PlaygroundPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [flags, setFlags] = useState<Record<number, Flags>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || loading) return;

    setError(null);
    setLoading(true);
    setInput("");

    const history = turns;
    setTurns([...history, { role: "user", content: message }]);

    try {
      const res = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Fallo la llamada");
        return;
      }

      setTurns((prev) => {
        const next: Turn[] = [
          ...prev,
          { role: "assistant", content: data.text || "(sin respuesta)" },
        ];
        setFlags((f) => ({
          ...f,
          [next.length - 1]: {
            priceLeaked: data.priceLeaked,
            handoffReason: data.handoffReason,
            refused: data.refused,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
          },
        }));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setTurns([]);
    setFlags({});
    setError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Playground</h1>
          <p className="text-xs text-muted">
            Mismo prompt que el DM real. No manda nada por Instagram y no guarda
            la conversacion.
          </p>
        </div>
        <button
          onClick={reset}
          className="self-start rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-all hover:border-border-hover hover:text-foreground"
        >
          Reiniciar
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRUEBAS.map((p) => (
          <button
            key={p}
            onClick={() => void send(p)}
            disabled={loading}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-all hover:border-border-hover hover:text-foreground disabled:opacity-50"
          >
            {p}
          </button>
        ))}
      </div>

      <div className="min-h-[24rem] space-y-4 rounded-lg border border-border bg-surface p-4">
        {turns.length === 0 && (
          <p className="text-xs text-muted">
            Escribi como si fueras un artista que acaba de recibir el lead
            magnet, o tocá una de las pruebas de arriba.
          </p>
        )}

        {turns.map((turn, i) => (
          <div
            key={i}
            className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div className="max-w-[80%] space-y-1">
              <div
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  turn.role === "user"
                    ? "bg-accent/15 text-accent border border-accent/20"
                    : "border border-border bg-background text-foreground"
                }`}
              >
                {turn.content}
              </div>

              {flags[i]?.priceLeaked && (
                <p className="text-[11px] text-red-400">
                  ⚠ El modelo dejo escapar un precio — el guardrail reemplazo la
                  respuesta. Ajustar el prompt.
                </p>
              )}
              {flags[i]?.refused && (
                <p className="text-[11px] text-red-400">
                  ⚠ El modelo no respondio. En produccion esto deriva a NEEDS_HUMAN.
                </p>
              )}
              {flags[i]?.handoffReason && (
                <p className="text-[11px] text-amber-400">
                  ⚠ En produccion esto NO llega a la IA: deriva a una persona (
                  {flags[i]?.handoffReason}).
                </p>
              )}
              {turn.role === "assistant" && (
                <p className="text-[11px] text-muted">
                  {turn.content.length} caracteres
                  {flags[i]?.inputTokens != null &&
                    ` · ${flags[i]?.inputTokens} in / ${flags[i]?.outputTokens} out`}
                </p>
              )}
            </div>
          </div>
        ))}

        {loading && <p className="text-xs text-muted">Pensando…</p>}
        {error && (
          <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribi como el artista…"
          disabled={loading}
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-all placeholder:text-muted focus:border-border-hover disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg border border-accent/20 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-50"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
