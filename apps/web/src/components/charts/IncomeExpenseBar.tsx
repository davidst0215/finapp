import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatCurrency } from '@/lib/utils';

interface BarData {
  month: string;
  income: number;
  expenses: number;
}

interface Props {
  data: BarData[];
}

export function IncomeExpenseBar({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="card text-center py-6">
        <p className="text-slate-500 text-sm">Sin datos mensuales</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="font-semibold text-sm mb-3">Ingresos vs Gastos (6 meses)</h3>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2}>
            <XAxis
              dataKey="month"
              tick={{ fill: '#64748b', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide />
            <Tooltip
              formatter={(value: number) => formatCurrency(value)}
              contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '0.75rem', fontSize: '12px' }}
              itemStyle={{ color: '#e2e8f0' }}
              labelStyle={{ color: '#94a3b8' }}
            />
            <Legend
              formatter={(value: string) => (
                <span className="text-xs text-slate-400">{value === 'income' ? 'Ingresos' : 'Gastos'}</span>
              )}
            />
            <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={24} name="income" />
            <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={24} name="expenses" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
