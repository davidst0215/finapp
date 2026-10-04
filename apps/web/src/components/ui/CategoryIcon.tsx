import {
  Utensils, Car, Clapperboard, ShoppingCart, Heart, GraduationCap,
  Lightbulb, Home, Shirt, Smartphone, Tv, PawPrint, Gift, FileText,
  Wallet, Laptop, Building2, TrendingUp, RefreshCw, BarChart3, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const iconMap: Record<string, LucideIcon> = {
  // Gastos
  'Alimentación': Utensils,
  'Transporte': Car,
  'Entretenimiento': Clapperboard,
  'Compras': ShoppingCart,
  'Salud': Heart,
  'Educación': GraduationCap,
  'Servicios': Lightbulb,
  'Vivienda': Home,
  'Ropa': Shirt,
  'Tecnología': Smartphone,
  'Suscripciones': Tv,
  'Mascotas': PawPrint,
  'Regalos': Gift,
  'Otros gastos': FileText,
  // Ingresos
  'Sueldo': Wallet,
  'Freelance': Laptop,
  'Negocio': Building2,
  'Inversiones': TrendingUp,
  'Devolución préstamo': RefreshCw,
  'Trading': BarChart3,
  'Otros ingresos': Sparkles,
};

// Monocromo: el ícono distingue la categoría, no el color (ver DESIGN.md).
const ICON_COLOR = 'rgb(var(--slate-200))';

interface CategoryIconProps {
  name?: string | null;
  emoji?: string | null;
  color?: string | null;
  size?: number;
  className?: string;
  showBackground?: boolean;
}

export function CategoryIcon({
  name,
  emoji,
  size = 18,
  className,
  showBackground = true,
}: CategoryIconProps) {
  const Icon = (name && iconMap[name]) || null;

  if (!Icon) {
    // Fallback: emoji in a circle
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-xl flex-shrink-0',
          showBackground && 'bg-slate-800',
          className,
        )}
        style={{ width: size + 14, height: size + 14 }}
      >
        <span style={{ fontSize: size - 2 }}>{emoji || '•'}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-xl flex-shrink-0',
        showBackground && 'bg-slate-800',
        className,
      )}
      style={{ width: size + 14, height: size + 14 }}
    >
      <Icon size={size} style={{ color: ICON_COLOR }} strokeWidth={1.6} />
    </div>
  );
}
