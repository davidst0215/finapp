import { useEffect, useState } from 'react';
import { Loader2, TrendingUp, TrendingDown, AlertTriangle, Lightbulb, BarChart3, Brain } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { SpendingPieChart } from '@/components/charts/SpendingPieChart';
import { IncomeExpenseBar } from '@/components/charts/IncomeExpenseBar';

interface Analysis {
  summary: string;
  insights: string[];
  alerts: string[];
  tips: string[];
  score: number;
}

interface MonthData {
  year: number;
  month: number;
  total_income: number;
  total_expenses: number;
  net_balance: number;
  transaction_count: number;
}

interface CategorySpending {
  category_id: string;
  category_name: string;
  icon: string | null;
  color: string | null;
  total_amount: number;
  transaction_count: number;
  percentage: number;
}

export function ReportsPage() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [currentMonth, setCurrentMonth] = useState<MonthData | null>(null);
  const [prevMonth, setPrevMonth] = useState<MonthData | null>(null);
  const [categorySpending, setCategorySpending] = useState<CategorySpending[]>([]);
  const [monthlyBarData, setMonthlyBarData] = useState<Array<{ month: string; income: number; expenses: number }>>([]);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Gastos por categoría
    const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
    const endOfMonth = new Date(year, month, 0).toISOString().slice(0, 10);
    const { data: cats } = await supabase.rpc('fn_get_spending_by_category', {
      p_start_date: startOfMonth,
      p_end_date: endOfMonth,
    });
    if (cats) setCategorySpending(cats as CategorySpending[]);

    // Barras últimos 6 meses
    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const bars = [];
    for (let i = 5; i >= 0; i--) {
      let m = month - i;
      let y = year;
      if (m <= 0) { m += 12; y -= 1; }
      const { data } = await supabase.rpc('fn_get_monthly_summary', { p_year: y, p_month: m });
      const row = data?.[0] as MonthData | undefined;
      bars.push({
        month: monthNames[m - 1] ?? '',
        income: row?.total_income ?? 0,
        expenses: row?.total_expenses ?? 0,
      });
    }
    setMonthlyBarData(bars);
    setLoadingData(false);
  }

  async function runAnalysis() {
    setLoadingAnalysis(true);
    setAnalysisError(null);

    try {
      const { data, error } = await supabase.functions.invoke('ai-analysis', {});
      if (error) throw new Error(error.message);
      if (data.error) throw new Error(data.error);

      setAnalysis(data.analysis);
      setCurrentMonth(data.current_month);
      setPrevMonth(data.prev_month);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Error al generar análisis');
    }

    setLoadingAnalysis(false);
  }

  const getScoreColor = (score: number) => {
    if (score >= 8) return 'text-income';
    if (score >= 5) return 'text-yellow-400';
    return 'text-expense';
  };

  const getScoreLabel = (score: number) => {
    if (score >= 9) return 'Excelente';
    if (score >= 7) return 'Bueno';
    if (score >= 5) return 'Regular';
    if (score >= 3) return 'Necesita atención';
    return 'Crítico';
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Reportes</h1>

      {/* Botón de análisis IA */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Brain size={18} className="text-primary-400" />
            <h3 className="font-semibold text-sm">Análisis con IA</h3>
          </div>
          {analysis && (
            <div className={cn('text-2xl font-bold', getScoreColor(analysis.score))}>
              {analysis.score}/10
              <span className="text-xs ml-1 font-normal">{getScoreLabel(analysis.score)}</span>
            </div>
          )}
        </div>

        {!analysis && !loadingAnalysis && (
          <button onClick={runAnalysis} className="btn-primary w-full flex items-center justify-center gap-2">
            <Brain size={16} /> Generar análisis del mes
          </button>
        )}

        {loadingAnalysis && (
          <div className="text-center py-4">
            <Loader2 size={24} className="animate-spin mx-auto text-primary-500 mb-2" />
            <p className="text-xs text-slate-500">Analizando tus finanzas con IA...</p>
          </div>
        )}

        {analysisError && (
          <div className="text-center py-3">
            <p className="text-xs text-expense mb-2">{analysisError}</p>
            <button onClick={runAnalysis} className="btn-secondary text-xs px-4 py-1.5">Reintentar</button>
          </div>
        )}

        {analysis && (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">{analysis.summary}</p>

            {/* Comparativa */}
            {currentMonth && prevMonth && (
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-800 rounded-lg p-2.5">
                  <p className="text-[10px] text-slate-500 mb-1">Gastos este mes</p>
                  <p className="text-sm font-bold text-expense">{formatCurrency(currentMonth.total_expenses)}</p>
                  {prevMonth.total_expenses > 0 && (
                    <p className={cn('text-[10px] flex items-center gap-0.5 mt-0.5',
                      currentMonth.total_expenses > prevMonth.total_expenses ? 'text-expense' : 'text-income'
                    )}>
                      {currentMonth.total_expenses > prevMonth.total_expenses ? (
                        <><TrendingUp size={10} /> +{((currentMonth.total_expenses / prevMonth.total_expenses - 1) * 100).toFixed(0)}% vs mes anterior</>
                      ) : (
                        <><TrendingDown size={10} /> {((currentMonth.total_expenses / prevMonth.total_expenses - 1) * 100).toFixed(0)}% vs mes anterior</>
                      )}
                    </p>
                  )}
                </div>
                <div className="bg-slate-800 rounded-lg p-2.5">
                  <p className="text-[10px] text-slate-500 mb-1">Balance neto</p>
                  <p className={cn('text-sm font-bold', currentMonth.net_balance >= 0 ? 'text-income' : 'text-expense')}>
                    {formatCurrency(currentMonth.net_balance)}
                  </p>
                </div>
              </div>
            )}

            {/* Insights */}
            {analysis.insights.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 font-medium mb-1.5 flex items-center gap-1">
                  <BarChart3 size={12} /> Insights
                </p>
                <div className="space-y-1">
                  {analysis.insights.map((insight, i) => (
                    <p key={i} className="text-xs text-slate-300 pl-3 border-l-2 border-primary-600">{insight}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Alertas */}
            {analysis.alerts.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 font-medium mb-1.5 flex items-center gap-1">
                  <AlertTriangle size={12} className="text-yellow-400" /> Alertas
                </p>
                <div className="space-y-1">
                  {analysis.alerts.map((alert, i) => (
                    <p key={i} className="text-xs text-yellow-300 pl-3 border-l-2 border-yellow-500">{alert}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Tips */}
            {analysis.tips.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 font-medium mb-1.5 flex items-center gap-1">
                  <Lightbulb size={12} className="text-income" /> Consejos
                </p>
                <div className="space-y-1">
                  {analysis.tips.map((tip, i) => (
                    <p key={i} className="text-xs text-slate-300 pl-3 border-l-2 border-income">{tip}</p>
                  ))}
                </div>
              </div>
            )}

            <button onClick={runAnalysis} className="btn-secondary w-full text-xs py-2">
              Regenerar análisis
            </button>
          </div>
        )}
      </div>

      {/* Gráficos */}
      {loadingData ? (
        <div className="text-center py-6 text-slate-500">
          <Loader2 size={24} className="animate-spin mx-auto mb-2 text-primary-500" />
          <p className="text-sm">Cargando datos...</p>
        </div>
      ) : (
        <>
          <SpendingPieChart
            data={categorySpending}
            totalExpenses={categorySpending.reduce((s, c) => s + c.total_amount, 0)}
          />
          <IncomeExpenseBar data={monthlyBarData} />
        </>
      )}
    </div>
  );
}
