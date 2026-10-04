import { useCallback, useEffect, useRef, useState } from 'react';
import { vaultApi } from '../tareas/api';
import { errorMessage } from '../tareas/format';
import type { ClienteChip, SearchRelated, SearchSource } from '../tareas/types';
import { clearRecents, loadRecents, pushRecent, saveRecents } from './recents';

export type SearchPhase = 'idle' | 'searching' | 'answering' | 'done' | 'error';

export interface SearchOutcome {
  q: string;
  sources: SearchSource[];
  related: SearchRelated[];
  /** Respuesta redactada; llega en la segunda fase. */
  answer: string | null;
  /** Motivo por el que no hubo respuesta (el de la respuesta o el del fallo de la segunda llamada). */
  answerError: string | null;
}

/**
 * Búsqueda en dos fases: primero las fuentes con sus fragmentos (rápido) y después la respuesta redactada,
 * que se inserta arriba cuando llega. Si la segunda falla, las fuentes se quedan y se muestra el motivo.
 * Cada búsqueda nueva invalida a la anterior: una respuesta que llega tarde se descarta.
 */
export function useSearch() {
  const [query, setQuery] = useState('');
  const [cliente, setCliente] = useState<string | null>(null);
  const [clientes, setClientes] = useState<ClienteChip[]>([]);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [recents, setRecents] = useState<string[]>(loadRecents);
  const recentsRef = useRef(recents);
  const seq = useRef(0);

  // Antes de la primera búsqueda: los chips de cliente y el total indexado (search('') no busca nada).
  const boot = useCallback(async () => {
    setBootError(null);
    try {
      const res = await vaultApi.search('');
      setClientes(res.clientes);
      setIndexed(res.indexed);
    } catch (e) {
      setBootError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const run = useCallback(async (text: string, filter: string | null) => {
    const q = text.trim();
    if (!q) return;
    const mine = ++seq.current;
    setQuery(q);
    setPhase('searching');
    setOutcome(null);
    setError(null);

    try {
      const first = await vaultApi.search(q, { cliente: filter, answer: false });
      if (mine !== seq.current) return;
      setClientes(first.clientes);
      setIndexed(first.indexed);
      setOutcome({ q, sources: first.sources, related: first.related, answer: null, answerError: null });
      if (first.sources.length === 0) {
        setPhase('done');
        return;
      }
      const next = pushRecent(recentsRef.current, q);
      recentsRef.current = next;
      setRecents(next);
      saveRecents(next);
      setPhase('answering');
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorMessage(e));
      setPhase('error');
      return;
    }

    try {
      const full = await vaultApi.search(q, { cliente: filter, answer: true });
      if (mine !== seq.current) return;
      // Las fuentes ya están en pantalla (y quizá abiertas): solo se agrega la respuesta.
      setOutcome((cur) => cur && { ...cur, answer: full.answer, answerError: full.answer ? null : full.answerError });
    } catch (e) {
      if (mine !== seq.current) return;
      setOutcome((cur) => cur && { ...cur, answerError: errorMessage(e) });
    }
    if (mine === seq.current) setPhase('done');
  }, []);

  const submit = useCallback((text?: string) => run(text ?? query, cliente), [run, query, cliente]);

  /** Cambiar de chip relanza la búsqueda si hay texto. */
  const selectCliente = useCallback(
    (next: string | null) => {
      setCliente(next);
      if (query.trim()) void run(query, next);
    },
    [query, run],
  );

  /** Borrar el texto vuelve al estado inicial y descarta lo que vaya en vuelo. */
  const clear = useCallback(() => {
    seq.current += 1;
    setQuery('');
    setPhase('idle');
    setOutcome(null);
    setError(null);
  }, []);

  const forgetRecents = useCallback(() => {
    clearRecents();
    recentsRef.current = [];
    setRecents([]);
  }, []);

  return {
    query,
    setQuery,
    cliente,
    clientes,
    indexed,
    bootError,
    boot,
    phase,
    outcome,
    error,
    recents,
    submit,
    selectCliente,
    clear,
    forgetRecents,
  };
}
