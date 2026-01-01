
import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

export function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}

export async function requireUser(req, sbAdmin) {
  const token = getBearerToken(req);
  if (!token) return { user: null, error: "missing_bearer" };

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) return { user: null, error: "invalid_token" };

  return { user: data.user, error: null };
    }
