// Supabase Edge Function: ai-chat
// Listens to POST /ai-chat, reads {"prompt": "..."}
// Validates JWT via Supabase Auth
// Calls Google Gemini using geminikey secret env var.

import { createClient } from "npm:@supabase/supabase-js@2.45.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length === 2 && /^bearer$/i.test(parts[0])) return parts[1];
  return null;
}

function textToReplyFromGemini(output: any): string {
  // Gemini response formats vary slightly by model/version.
  // We try common paths.
  const candidates = output?.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;

  const parts = first?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const textParts = parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .filter((s: string) => s.length > 0);
    if (textParts.length > 0) return textParts.join("");
  }

  // Fallbacks
  const fallback = first?.content?.parts?.[0]?.text;
  if (typeof fallback === "string") return fallback;

  if (typeof output?.text === "string") return output.text;
  return "";
}

Deno.serve(async (req: Request) => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // ==========================================
    // 1. JWT Authentication & Validation
    // ==========================================
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return jsonResponse(
        { error: "Missing required Supabase environment variables." },
        500
      );
    }

    const token = getBearerToken(req);
    if (!token) {
      return jsonResponse({ error: "Unauthorized: Missing JWT" }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const { data: authUser, error: userErr } = await supabase.auth.getUser();
    if (userErr || !authUser?.user) {
      return jsonResponse({ error: "Unauthorized: Invalid JWT" }, 401);
    }

    // ==========================================
    // 2. Process AI Request
    // ==========================================
    const apiKey = Deno.env.get("geminikey");
    if (!apiKey) {
      return jsonResponse({ error: "Missing environment variable: geminikey" }, 500);
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse({ error: "Content-Type must be application/json" }, 400);
    }

    const body = await req.json().catch(() => null);
    const prompt = body?.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return jsonResponse({ error: "Missing or invalid 'prompt'" }, 400);
    }

    // Google Gemini REST API (Generative Language API)
    const model = "gemini-3-flash-preview";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: 4096,
        },
      }),
    });

    const geminiJson = await geminiRes.json().catch(() => null);

    if (!geminiRes.ok) {
      return jsonResponse(
        {
          error: "Gemini API error",
          status: geminiRes.status,
          details: geminiJson,
        },
        502
      );
    }

    const reply = textToReplyFromGemini(geminiJson) ?? "";
    if (!reply) {
      return jsonResponse({ reply: "", note: "Gemini response had no text content" }, 200);
    }

    return jsonResponse({ reply });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders,
      },
    });
  }
});