import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { Loader2 } from 'lucide-react';

export function AuthPage() {
  const signInWithGoogle = useAuthStore(s => s.signInWithGoogle);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al iniciar sesión');
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 bg-slate-950 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full blur-3xl opacity-20"
        style={{ background: 'radial-gradient(circle, rgb(var(--halo) / 0.14) 0%, transparent 70%)' }} />

      {/* Orb */}
      <div className="ai-orb w-[80px] h-[80px] mb-8" />

      {/* Brand */}
      <div className="text-center mb-10 relative z-10">
        <h1 className="text-3xl font-bold text-slate-100 mb-2">Wabid</h1>
        <p className="text-slate-400 text-sm max-w-[250px]">
          Tu asistente personal
        </p>
      </div>

      {/* Login */}
      <div className="w-full max-w-sm space-y-4 relative z-10">
        <button
          onClick={handleSignIn}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 rounded-2xl bg-slate-100 px-4 py-3.5 font-semibold text-slate-900 active:bg-slate-200 transition-colors disabled:opacity-70"
        >
          {loading ? (
            <Loader2 size={20} className="animate-spin text-slate-600" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
          )}
          {loading ? 'Conectando...' : 'Continuar con Google'}
        </button>

        {error && (
          <div className="bg-expense/10 border border-expense/20 rounded-xl px-4 py-3 text-center">
            <p className="text-sm text-expense">{error}</p>
          </div>
        )}
      </div>

      <p className="mt-12 text-[10px] text-slate-700 text-center relative z-10">
        Tus datos financieros se almacenan de forma segura y encriptada.
      </p>
    </div>
  );
}
