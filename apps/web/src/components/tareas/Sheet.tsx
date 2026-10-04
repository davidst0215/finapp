import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Lo lee el lector de pantalla; con `hideDescription` no se dibuja. */
  description: ReactNode;
  hideDescription?: boolean;
  children: ReactNode;
  /** Zona fija al pie (acción principal), fuera del área que se desplaza. */
  footer?: ReactNode;
  onOpenAutoFocus?: (event: Event) => void;
}

/**
 * Hoja inferior sobre Radix Dialog: foco atrapado, Escape y aria-modal vienen de Radix.
 * Sin desenfoque ni vidrio (DESIGN.md): un velo plano y una superficie con borde.
 * La entrada se anima solo si el sistema lo permite; el estado nunca depende de la animación.
 */
export function Sheet({ open, onOpenChange, title, description, hideDescription = false, children, footer, onOpenAutoFocus }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl border border-b-0 border-slate-700 bg-slate-900 text-slate-100 outline-none selection:bg-slate-600 selection:text-slate-100 motion-safe:animate-slide-up"
        >
          <div className="flex items-start justify-between gap-3 px-4 pt-3">
            <div className="min-w-0 pt-1.5">
              <Dialog.Title className="text-lg font-bold leading-snug">{title}</Dialog.Title>
              <Dialog.Description
                className={cn('mt-0.5 line-clamp-2 text-[14px] leading-snug text-slate-400', hideDescription && 'sr-only')}
              >
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Cerrar"
                className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
              >
                <X aria-hidden="true" size={20} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2">{children}</div>

          {footer && (
            <div
              className="border-t border-slate-700 px-4 pt-3"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              {footer}
            </div>
          )}
          {!footer && <div style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
