import { AlertTriangle, Camera, PenLine, RefreshCw } from 'lucide-react';
import type { PreparedImage } from './prepareImage.ts';
import { PhotoThumb } from './PhotoThumb';
import type { ReceiptProblem } from './reciboLogic.ts';

interface Props {
  problem: ReceiptProblem;
  photo: PreparedImage | null;
  onTakeAnother: () => void;
  /** Solo si reenviar la misma foto puede servir. */
  onRetry?: () => void;
  /** Solo si se puede seguir a mano con la foto como referencia. */
  onWriteByHand?: () => void;
}

/** Fallo de la lectura: dice qué pasó, qué hacer, y deja a mano las salidas que sí sirven. */
export function ProblemPanel({ problem, photo, onTakeAnother, onRetry, onWriteByHand }: Props) {
  const takeAnother = (
    <button
      type="button"
      onClick={onTakeAnother}
      className={`${onRetry ? 'btn-secondary' : 'btn-primary'} flex w-full items-center justify-center gap-2`}
    >
      <Camera size={19} strokeWidth={1.8} aria-hidden="true" />
      Tomar otra foto
    </button>
  );

  return (
    <section aria-labelledby="recibo-problem-title" className="space-y-4">
      <div className="card flex items-start gap-4">
        {photo && <PhotoThumb photo={photo} />}
        <div role="alert" className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} strokeWidth={1.8} className="shrink-0 text-expense" aria-hidden="true" />
            <h2 id="recibo-problem-title" className="text-base font-semibold text-slate-100">
              {problem.title}
            </h2>
          </div>
          <p className="text-base leading-relaxed text-slate-300">{problem.hint}</p>
        </div>
      </div>

      <div className="space-y-3">
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-primary flex w-full items-center justify-center gap-2">
            <RefreshCw size={18} strokeWidth={1.8} aria-hidden="true" />
            Reintentar
          </button>
        )}
        {takeAnother}
        {onWriteByHand && (
          <button
            type="button"
            onClick={onWriteByHand}
            className="btn-secondary flex w-full items-center justify-center gap-2"
          >
            <PenLine size={18} strokeWidth={1.8} aria-hidden="true" />
            Escribirlo a mano
          </button>
        )}
      </div>
    </section>
  );
}
