// Medición de fases del agente (Server-Timing).
// Sin globals de Deno: se prueba con Node (tiempos.test.ts).

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };

export class Tiempos {
  private readonly inicio = performance.now();
  private readonly fases: [string, number][] = [];
  private uso: Usage | null = null;

  // Mide cuánto tarda en resolverse la promesa, aunque corra en paralelo con otras.
  async medir<T>(fase: string, p: Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await p;
    } finally {
      this.fases.push([fase, Math.round(performance.now() - t0)]);
    }
  }

  tokens(uso: Usage | undefined) {
    this.uso = uso ?? null;
  }

  resumen() {
    return {
      ...Object.fromEntries(this.fases),
      total: Math.round(performance.now() - this.inicio),
      ...(this.uso
        ? { tok_in: this.uso.prompt_tokens, tok_cache: this.uso.prompt_tokens_details?.cached_tokens ?? 0, tok_out: this.uso.completion_tokens }
        : {}),
    };
  }

  header() {
    const fases = this.fases.map(([f, ms]) => `${f};dur=${ms}`);
    const tok = this.uso
      ? [`tok;desc="in=${this.uso.prompt_tokens ?? 0} cache=${this.uso.prompt_tokens_details?.cached_tokens ?? 0} out=${this.uso.completion_tokens ?? 0}"`]
      : [];
    return [...fases, `total;dur=${Math.round(performance.now() - this.inicio)}`, ...tok].join(", ");
  }
}
