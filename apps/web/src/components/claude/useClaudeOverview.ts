import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { ApiError, claudeApi } from './api';
import type { Decision, DeviceView, Overview, PairedDevice } from './types';

// Sin Realtime (habría que tocar la configuración de Supabase): se consulta cada pocos segundos mientras la
// pantalla está a la vista. Una aprobación vence a los 2 min, así que 3 s es margen de sobra.
const POLL_MS = 3000;

const toast = (message: string, type: 'success' | 'error' | 'info') => useToastStore.getState().addToast(message, type);
const messageOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function useClaudeOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  /** performance.now() del último éxito: las cuentas regresivas se calculan contra esto, no contra el reloj del celular. */
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await claudeApi.overview(controller.signal);
      if (controller.signal.aborted) return;
      setOverview(data);
      setFetchedAt(performance.now());
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
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      inFlight.current?.abort();
    };
  }, [refresh]);

  const decide = useCallback(
    async (approvalId: string, decision: Decision) => {
      try {
        await claudeApi.decide(approvalId, decision);
        toast(decision === 'aprobar' ? 'Aprobado. Claude Code continúa.' : 'Rechazado.', 'success');
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) toast('Esa solicitud ya no estaba pendiente.', 'info');
        else toast(messageOf(e, 'No se pudo enviar tu respuesta.'), 'error');
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
        toast('Laptop revocada.', 'success');
      } catch (e) {
        toast(messageOf(e, 'No se pudo revocar. Reintenta.'), 'error');
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

  return { overview, fetchedAt, error, loading, refresh, decide, setApprovals, revoke, pair };
}
