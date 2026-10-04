import { Camera, Image as ImageIcon, ReceiptText } from 'lucide-react';

interface Props {
  onTakePhoto: () => void;
  onPickFile: () => void;
}

/** Estado inicial: encuadrar la boleta y elegir de dónde sale la foto. */
export function CapturePanel({ onTakePhoto, onPickFile }: Props) {
  return (
    <section aria-labelledby="recibo-capture-title" className="flex min-h-[calc(100dvh-13rem)] flex-col gap-4">
      <div className="card relative flex min-h-[232px] flex-1 items-center justify-center p-0">
        <div aria-hidden="true" className="absolute inset-4 rounded-xl border-2 border-slate-600" />
        <div className="relative flex max-w-[28ch] flex-col items-center gap-2 px-8 py-10 text-center">
          <ReceiptText size={32} strokeWidth={1.5} className="text-slate-400" aria-hidden="true" />
          <h2 id="recibo-capture-title" className="text-base font-semibold text-slate-100">
            Encuadra la boleta completa
          </h2>
          <p className="text-base leading-relaxed text-slate-400">Con buena luz y el total a la vista.</p>
        </div>
      </div>

      <div className="space-y-3">
        <button type="button" onClick={onTakePhoto} className="btn-primary flex w-full items-center justify-center gap-2">
          <Camera size={19} strokeWidth={1.8} aria-hidden="true" />
          Tomar foto
        </button>
        <button type="button" onClick={onPickFile} className="btn-secondary flex w-full items-center justify-center gap-2">
          <ImageIcon size={19} strokeWidth={1.8} aria-hidden="true" />
          Elegir de la galería
        </button>
      </div>
    </section>
  );
}
