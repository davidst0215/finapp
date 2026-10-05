import { create } from 'zustand';
import type { User as SupabaseUser, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { clearCache } from '@/lib/moduleCache';
import type { User } from '@/types/database';

interface AuthState {
  session: Session | null;
  user: SupabaseUser | null;
  profile: User | null;
  loading: boolean;
  initialized: boolean;
  initialize: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  loading: true,
  initialized: false,

  initialize: async () => {
    try {
      // First get the current session
      const { data: { session } } = await supabase.auth.getSession();
      set({ session, user: session?.user ?? null });

      if (session?.user) {
        await get().fetchProfile();
      }

      // Set up the listener for future changes
      supabase.auth.onAuthStateChange(async (_event, session) => {
        set({ session, user: session?.user ?? null });
        if (session?.user) {
          await get().fetchProfile();
        } else {
          clearCache();
          set({ profile: null });
        }
      });
    } finally {
      // Always mark as initialized, even on error
      set({ loading: false, initialized: true });
    }
  },

  signInWithGoogle: async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  },

  signOut: async () => {
    await supabase.auth.signOut();
    clearCache();
    set({ session: null, user: null, profile: null });
  },

  fetchProfile: async () => {
    const { user } = get();
    if (!user) return;

    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (data) {
      set({ profile: data });
    } else {
      const { data: newProfile } = await supabase
        .from('users')
        .insert({
          user_id: user.id,
          display_name: user.user_metadata?.['full_name'] ?? user.email ?? 'Usuario',
        })
        .select()
        .single();
      set({ profile: newProfile });
    }
  },
}));
