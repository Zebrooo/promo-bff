/**
 * User profile client backed by Supabase (PostgREST), reading abkhaz-auto
 * `profiles`. Only fields targeting uses live here.
 *
 *   region ← profiles.city (a region slug, e.g. 'sukhum'; matches targeting.regions)
 *   age    ← computed from profiles.birthdate; undefined when the user hasn't set one
 *
 * Missing row, no birthdate, and unconfigured Supabase all yield age undefined
 * (no fake default). Only a connection/query failure throws.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

/** Region we report when unknown; matches no targeting.regions entry. */
export const UNKNOWN_REGION = '';

export interface UserProfile {
  userId: string;
  /** Full years from birthdate; undefined when unknown (no birthdate). */
  age?: number;
  region: string;
}

export interface UserService {
  getUserProfile(userId: string): Promise<UserProfile>;
}

interface ProfileRow {
  city: string | null;
  birthdate: string | null;
}

/** Full-year age from an ISO date (YYYY-MM-DD); undefined if absent/unparseable/out of [0,150). */
export function ageFromBirthdate(birthdate: string | null, now: Date = new Date()): number | undefined {
  if (!birthdate) return undefined;
  const dob = new Date(birthdate);
  if (Number.isNaN(dob.getTime())) return undefined;
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age >= 0 && age < 150 ? age : undefined;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function defaultProfile(userId: string): UserProfile {
  return { userId, region: UNKNOWN_REGION };
}

export function createUserService(cfg: SupabaseConfig = config.supabase): UserService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getUserProfile: async (userId) => defaultProfile(userId) };
  }
  const table = `${url}/rest/v1/profiles`;

  async function getUserProfile(userId: string): Promise<UserProfile> {
    const qs = `id=eq.${encodeURIComponent(userId)}&select=city,birthdate&limit=1`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`user-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ProfileRow[];
    const row = rows[0];
    if (!row) return defaultProfile(userId);
    return { userId, age: ageFromBirthdate(row.birthdate), region: row.city ?? UNKNOWN_REGION };
  }

  return {
    getUserProfile: (userId) =>
      withTimeout(getUserProfile(userId), timeoutMs, 'userService.getUserProfile'),
  };
}
