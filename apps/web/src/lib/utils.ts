import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = 'PEN'): string {
  // El dólar siempre «US$ 500.00»: según el navegador Intl lo escribe «USD 500.00» o «US$ 500.00», y la misma cifra no puede verse de
  // dos maneras en una pantalla (ni distinta de lo que dice Wabid).
  if (currency === 'USD') {
    const n = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
    return `${amount < 0 ? '-' : ''}US$ ${n}`;
  }
  return new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

// "AAAA-MM-DD" se interpreta como fecha local: new Date('2026-10-04') es medianoche UTC
// y en Lima (UTC-5) retrocede al día anterior.
export function toLocalDate(date: string | Date): Date {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d!);
  }
  return new Date(date);
}

export function localDateKey(date: string | Date): string {
  const d = toLocalDate(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(toLocalDate(date));
}

export function formatDateShort(date: string | Date): string {
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
  }).format(toLocalDate(date));
}
