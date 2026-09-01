import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { authenticationFailed, sessionExpired } from './errors.mjs';

const PROFILE_FIELDS = 'id,auth_id,username,name,role,department_id';

function expiresAtMs(session, now) {
  if (Number.isFinite(session?.expires_at)) return Number(session.expires_at) * 1000;
  if (Number.isFinite(session?.expires_in)) return now() + Number(session.expires_in) * 1000;
  return now() + 60 * 60 * 1000;
}

function clientOptions(extra = {}) {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    ...extra,
  };
}

export function createSupabaseAuthProvider({ config, createClient = createSupabaseClient, now = Date.now }) {
  const publicClient = () => createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    clientOptions(),
  );

  return {
    async checkReadiness() {
      const result = await publicClient().rpc('mcp_get_readiness');
      if (result?.error) throw new Error('readiness rpc unavailable');
      return result?.data && typeof result.data === 'object' ? result.data : { status: 'degraded' };
    },

    async authenticate({ email, password }) {
      const client = publicClient();
      let authResult;
      try {
        authResult = await client.auth.signInWithPassword({ email, password });
      } catch {
        throw authenticationFailed();
      }

      const authUser = authResult?.data?.user;
      const session = authResult?.data?.session;
      if (authResult?.error || !authUser?.id || !session?.access_token || !session?.refresh_token) {
        throw authenticationFailed();
      }

      let profileResult;
      try {
        profileResult = await client
          .from('users')
          .select(PROFILE_FIELDS)
          .eq('auth_id', authUser.id)
          .maybeSingle();
      } catch {
        throw authenticationFailed();
      }

      const profile = profileResult?.data;
      if (profileResult?.error || !profile?.id || profile.auth_id !== authUser.id) {
        throw authenticationFailed();
      }

      return {
        authUserId: authUser.id,
        userId: profile.id,
        username: profile.username,
        name: profile.name,
        role: profile.role,
        departmentId: profile.department_id ?? null,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        tokenExpiresAt: expiresAtMs(session, now),
      };
    },

    async refresh(context) {
      if (!context?.refreshToken) throw sessionExpired();
      const client = publicClient();
      let refreshResult;
      try {
        refreshResult = await client.auth.refreshSession({ refresh_token: context.refreshToken });
      } catch {
        throw sessionExpired();
      }

      const session = refreshResult?.data?.session;
      if (refreshResult?.error || !session?.access_token || !session?.refresh_token) {
        throw sessionExpired();
      }

      return {
        ...context,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        tokenExpiresAt: expiresAtMs(session, now),
      };
    },

    createUserClient(accessToken) {
      return createClient(
        config.supabaseUrl,
        config.supabasePublishableKey,
        clientOptions({
          global: { headers: { Authorization: `Bearer ${accessToken}` } },
        }),
      );
    },
  };
}
