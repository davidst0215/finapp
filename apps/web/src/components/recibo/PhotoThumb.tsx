import { Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PreparedImage } from './prepareImage.ts';

interface Props {
  photo: PreparedImage;
  /** Con `onToggle` la miniatura es un botón que expande la foto; sin él, es solo una referencia. */
  expanded?: boolean;
  onToggle?: () => void;
}

const FRAME = 'relative h-[72px] w-14 shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-800';

export function PhotoThumb({ photo, expanded = false, onToggle }: Props) {
  const image = <img src={photo.previewUrl} alt="" className="h-full w-full object-cover" />;
  if (!onToggle) return <div className={FRAME}>{image}</div>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? 'Ocultar la foto' : 'Ver la foto completa'}
      className={cn(FRAME, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500')}
    >
      {image}
      <span
        aria-hidden="true"
        className="absolute bottom-0 right-0 flex h-5 w-5 items-center justify-center rounded-tl-md bg-slate-950/80 text-slate-100"
      >
        <Maximize2 size={11} strokeWidth={2} />
      </span>
    </button>
  );
}
