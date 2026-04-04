import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatCurrency } from '@/lib/utils';

interface CategoryData {
  category_id: string;
  category_name: string;
  icon: string | null;
  color: string | null;
  total_amount: number;
  transaction_count: number;
  percentage: number;
}

interface Props {
  data: CategoryData[];
  totalExpenses: number;
}

const DEFAULT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

export function SpendingPieChart({ data, totalExpenses }: Props) {
  if (data.length === 0) {
    return (
      <div className="card text-center py-6">
        <p className="text-slate-500 text-sm">Sin datos de gastos por categoría</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="font-semibold text-sm mb-3">Gastos por categoría</h3>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="total_amount"
              nameKey="category_name"
              cx="50%"
              cy="50%"
              innerRadius={45}
              outerRadius={75}
              paddingAngle={2}
            >
              {data.map((entry, i) => (
                <Cell key={entry.category_id} fill={entry.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatCurrency(value)}
              contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '0.75rem', fontSize: '12px' }}
              itemStyle={{ color: '#e2e8f0' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* Leyenda */}
      <div className="grid grid-cols-2 gap-1.5 mt-2">
        {data.slice(0, 6).map((cat, i) => (
          <div key={cat.category_id} className="flex items-center gap-2 text-xs">
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: cat.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length] }}
            />
            <span className="text-slate-400 truncate">{cat.icon} {cat.category_name}</span>
            <span className="text-slate-500 ml-auto">{cat.percentage.toFixed(0)}%</span>
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-slate-500 mt-3">
        Total: {formatCurrency(totalExpenses)}
      </p>
    </div>
  );
}
