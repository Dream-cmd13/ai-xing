import { create } from 'zustand';
import { User } from '../types';
import { supabase } from '../supabase';

interface AuthState {
  isAuthenticated: boolean;
  currentUser: User | null;
  login: (user: User) => void;
  logout: () => Promise<void>;
  updateCurrentUser: (user: User) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  currentUser: null,
  login: (user) => set({ isAuthenticated: true, currentUser: user }),
  logout: async () => {
    set({ isAuthenticated: false, currentUser: null });
    localStorage.removeItem('stratflow_session');
    await supabase.auth.signOut();
  },
  updateCurrentUser: (user) => set({ currentUser: user }),
}));
