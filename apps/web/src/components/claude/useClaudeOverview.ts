import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, useCachedState, writeCache } from '@/lib/moduleCache';
import { useToastStore } from '@/stores/toastStore';
import { ApiError, claudeApi } from './api';
import type { Decision, DeviceView, MessageView, Overview, PairedDevice, TaskView } from './types';

// Sondeo en vez de Supabase Realtime, a propósito: (1) Realtime exige publicar las tablas claude_* y suscribirse con RLS, y la
// columna `body` de los mensajes no tiene permiso de lectura para el cliente (el chat lo sirve la función, ya redactado);
// (2) la línea de tiempo se arma en el servidor mezclando cinco fuentes, no es una tabla que se pueda suscribir; (3) con una
// sola persona usando la pantalla, una consulta pequeña cada pocos segundos mientras está a la vista no pesa. Se pausa con la
// pestaña oculta y se adelanta justo después de cada acción de David. Una aprobación vence a los 2 min: 3 s es margen de sobra.
export const POLL_MS = 3000;

const toast = (message: string, type: 'success' | 'error' | 'info') => useToastStore.getState().addToast(message, type);
const messageOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function useClaudeOverview(pollMs: number = POLL_MS) {
  // Al volver a la pantalla se ve lo último mientras llega la primera consulta.
  const [overview, setOverview] = useCachedState<Overview>('claude.overview');
  /** performance.now() del último éxito: las cuentas regresivas se calculan contra esto, no contra el reloj del celular. */
  const [fetchedAt, setFetchedAt] = useState(() => readCache<number>('claude.fetchedAt') ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !overview);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await claudeApi.overview(controller.signal);
      if (controller.signal.aborted) return;
      const at = performance.now();
      setOverview(data);
      setFetchedAt(at);
      writeCache('claude.fetchedAt', at);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(messageOf(e, 'No se pudo cargar Claude Code. Reintenta.'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const id = window.setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      inFlight.current?.abort();
    };
  }, [refresh, pollMs]);

  /** true si el servidor aceptó. El error ya se avisó con un toast; el éxito se ve en la tarjeta, no se avisa. */
  const decide = useCallback(
    async (approvalId: string, decision: Decision): Promise<boolean> => {
      try {
        await claudeApi.decide(approvalId, decision);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) toast('Esa solicitud ya no estaba pendiente.', 'info');
        else toast(messageOf(e, 'No se pudo enviar tu respuesta.'), 'error');
        return false;
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const setApprovals = useCallback(
    async (deviceId: string, enabled: boolean) => {
      // Optimista: el interruptor responde al instante y se corrige si el servidor dice que no.
      const patch = (on: boolean) => (o: Overview | null) =>
        o && { ...o, devices: o.devices.map((d: DeviceView) => (d.id === deviceId ? { ...d, approvals_enabled: on } : d)) };
      setOverview(patch(enabled));
      try {
        await claudeApi.setApprovals(deviceId, enabled);
      } catch (e) {
        setOverview(patch(!enabled));
        toast(messageOf(e, 'No se pudo cambiar. Reintenta.'), 'error');
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (deviceId: string) => {
      try {
        await claudeApi.revoke(deviceId);
        toast('Laptop desconectada.', 'success');
      } catch (e) {
        toast(messageOf(e, 'No se pudo desconectar. Reintenta.'), 'error');
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const pair = useCallback(
    async (name: string): Promise<PairedDevice> => {
      const paired = await claudeApi.pair(name);
      await refresh();
      return paired;
    },
    [refresh],
  );

  /** El mensaje enviado, o el motivo del fallo para mostrarlo junto al compositor (sin toast: tapa el chat). */
  const sendMessage = useCallback(
    async (sessionId: string, text: string): Promise<{ message: MessageView } | { error: string }> => {
      try {
        const { message } = await claudeApi.sendMessage(sessionId, text);
        return { message };
      } catch (e) {
        return { error: messageOf(e, 'No se pudo enviar el mensaje. Reintenta.') };
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const createTask = useCallback(
    async (project: string, prompt: string): Promise<{ task: TaskView } | { error: string }> => {
      try {
        const { task } = await claudeApi.createTask(project, prompt);
        return { task };
      } catch (e) {
        return { error: messageOf(e, 'No se pudo crear la tarea. Reintenta.') };
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      try {
        await claudeApi.cancelTask(taskId);
        toast('Cancelando…', 'info');
      } catch (e) {
        toast(messageOf(e, 'No se pudo cancelar.'), 'error');
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return { overview, fetchedAt, error, loading, refresh, decide, setApprovals, revoke, pair, sendMessage, createTask, cancelTask };
}

export type ClaudeOverviewApi = ReturnType<typeof useClaudeOverview>;
