import { Loader2, Sun } from 'lucide-react';
import { SectionCards } from '@/components/brief/SectionCards';
import { SpokenCard } from '@/components/brief/SpokenCard';
import { useBrief } from '@/components/brief/useBrief';
import { ErrorCard, RowsSkeleton } from '@/components/google/Feedback';
import { dayHeading, limaDateKey, limaHM, shortHM } from '@/components/google/lima';
import { btnPrimary, focusRing } from '@/components/google/ui';

export function BriefPage() {
  const { brief, preview, hoy, status, error, reload, generate, generating, generateError } = useBrief();
  const today = hoy ?? limaDateKey();
  const isToday = brief !== null && brief.fecha === today;

  if (status === 'loading') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-100">Brief del día</h1>
        <RowsSkeleton rows={3} label="Cargando tu brief" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-100">Brief del día</h1>
        <ErrorCard message={error ?? 'No pude cargar tu brief.'} onRetry={reload} />
      </div>
    );
  }

  const generateButton = (
    <div className="space-y-3">
      <button type="button" onClick={() => void generate(false)} disabled={generating} className={`${btnPrimary} w-full`}>
        {generating && <Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />}
        {generating ? 'Armando tu brief' : 'Generar ahora'}
      </button>
      {generateError && <ErrorCard message={generateError} />}
    </div>
  );

  return (
    <div className="space-y-4">
      <header className="min-h-[44px]">
        <p className="text-sm text-slate-400">
          {brief && isToday && preview
            ? 'Vista previa · no se guardó'
            : brief && isToday
            ? `${brief.origen === 'cron' ? 'Enviado' : 'Generado'} a las ${shortHM(limaHM(new Date(brief.creado)))}`
            : 'Resumen de las 7:00'}
        </p>
        <h1 className="text-2xl font-bold text-slate-100">{brief && isToday ? brief.secciones.titulo : 'Brief del día'}</h1>
        <p className="text-base text-slate-300">{dayHeading(brief && isToday ? brief.fecha : today, today)}</p>
      </header>

      {brief && isToday ? (
        <>
          {preview && (
            <p role="status" className="card text-base text-slate-300">
              Esto es una vista previa: el brief se guarda desde las 7:00, o cuando todas las fuentes respondan.
            </p>
          )}
          <SpokenCard text={brief.texto} />
          <SectionCards s={brief.secciones} />
          <div className="space-y-3">
            <button type="button" onClick={() => void generate(true)} disabled={generating} className={`btn-secondary inline-flex min-h-[44px] w-full items-center justify-center gap-2 ${focusRing}`}>
              {generating && <Loader2 size={18} aria-hidden="true" className="motion-safe:animate-spin" />}
              {generating ? 'Actualizando' : 'Actualizar'}
            </button>
            {generateError && <ErrorCard message={generateError} />}
          </div>
        </>
      ) : (
        <>
          <div className="card flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800">
              <Sun size={22} strokeWidth={1.6} aria-hidden="true" className="text-slate-200" />
            </div>
            <p className="text-lg font-bold text-slate-100">Todavía no hay brief de hoy</p>
            <p className="max-w-[34ch] text-base text-slate-400">
              Llega solo a las 7:00. Si no llegó, puedes armarlo ahora.
            </p>
          </div>
          {generateButton}
          {brief && (
            <details className="card">
              <summary className="min-h-[44px] cursor-pointer py-2 text-base font-semibold text-slate-200">
                Ver el último ({dayHeading(brief.fecha, today)})
              </summary>
              <div className="space-y-4 pt-3">
                <SpokenCard text={brief.texto} />
                <SectionCards s={brief.secciones} />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
