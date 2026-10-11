import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AvisosAutomaticos } from '@/components/avisos/AvisosAutomaticos';
import { NoticeList } from '@/components/avisos/NoticeList';
import { PushSwitch } from '@/components/avisos/PushSwitch';
import { Recordatorios } from '@/components/avisos/Recordatorios';
import { TestPush } from '@/components/avisos/TestPush';
import { useInbox } from '@/components/avisos/useInbox';
import { useProgramados } from '@/components/avisos/useProgramados';
import { usePush } from '@/components/avisos/usePush';

// Avisos: activar las notificaciones push en este dispositivo, elegir qué avisos automáticos recibir, ver (y cancelar) los
// recordatorios pendientes y revisar la bandeja de lo que Wabid te avisó.
export function AvisosPage() {
  const push = usePush();
  const inbox = useInbox();
  const programados = useProgramados();

  const canTry = push.phase === 'checking' || push.phase === 'off' || push.phase === 'on';

  // El aviso de prueba también cae en la bandeja: se vuelve a leer al terminar.
  const sendTest = async () => {
    await push.sendTest();
    await inbox.reload();
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-1">
        <Link
          to="/more"
          aria-label="Volver a Más"
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 active:bg-slate-800"
        >
          <ArrowLeft size={22} strokeWidth={1.8} aria-hidden="true" />
        </Link>
        <h1 className="text-xl font-bold">Avisos</h1>
      </header>

      <section aria-label="Este dispositivo" className="card divide-y divide-slate-700 p-0">
        <PushSwitch phase={push.phase} busy={push.busy} error={push.error} onToggle={push.toggle} />
        {/* Sin soporte o con el permiso bloqueado no hay nada que probar: el texto de arriba ya explica por qué. */}
        {canTry && <TestPush phase={push.phase} testing={push.testing} outcome={push.testOutcome} onTest={sendTest} />}
      </section>

      <AvisosAutomaticos
        prefs={programados.prefs}
        status={programados.status}
        guardando={programados.guardando}
        error={programados.prefError}
        onChange={programados.cambiarPref}
      />

      <Recordatorios
        items={programados.items}
        status={programados.status}
        error={programados.error}
        onRetry={programados.retry}
        onCancel={programados.cancelar}
      />

      <NoticeList
        items={inbox.items}
        unread={inbox.unread}
        status={inbox.status}
        error={inbox.error}
        onRetry={inbox.retry}
        onRead={inbox.markRead}
        onReadAll={inbox.markAllRead}
      />
    </div>
  );
}
