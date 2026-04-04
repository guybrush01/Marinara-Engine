// ──────────────────────────────────────────────
// Routes: Browser — Pygmalion provider
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";

const PYGMALION_API_BASE = "https://server.pygmalion.chat/galatea.v1.PublicCharacterService";
const PYGMALION_AUTH_URL = "https://auth.pygmalion.chat/session";
const PYGMALION_ORIGIN = "https://pygmalion.chat";
const PYGMALION_ASSETS_BASE = "https://assets.pygmalion.chat";

// In-memory token store (persists until server restart)
let pygToken: string = "";

export async function botBrowserPygmalionRoutes(app: FastifyInstance) {
  // ── Login to Pygmalion via auth proxy ──
  app.post<{
    Body: { username: string; password: string };
  }>("/pygmalion/login", async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.status(400).send({ error: "username and password are required" });
    }
    if (typeof username !== "string" || typeof password !== "string" || username.length > 256 || password.length > 256) {
      return reply.status(400).send({ error: "Invalid credentials format" });
    }

    const body = new URLSearchParams({ username, password }).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(PYGMALION_AUTH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: PYGMALION_ORIGIN,
          Referer: `${PYGMALION_ORIGIN}/`,
        },
        body,
        signal: controller.signal,
      });

      const text = await res.text();

      if (res.ok) {
        // Try to extract token from response
        try {
          const data = JSON.parse(text);
          if (data?.token || data?.idToken || data?.access_token) {
            pygToken = data.token || data.idToken || data.access_token;
          }
        } catch {
          // Response might be the token itself
          if (text.length > 20 && text.length < 4096 && !text.includes("<")) {
            pygToken = text.trim();
          }
        }
      }

      return reply
        .status(res.status)
        .header("Content-Type", res.headers.get("content-type") || "application/json")
        .send(text);
    } catch (err) {
      return reply.status(502).send({ error: "Failed to reach Pygmalion auth server" });
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Logout (clear stored token) ──
  app.post("/pygmalion/logout", async () => {
    pygToken = "";
    return { ok: true };
  });

  // ── Check session status ──
  app.get("/pygmalion/session", async () => {
    return { active: !!pygToken, hasToken: !!pygToken };
  });

  // ── Store token directly (from client after login response parsing) ──
  app.post<{ Body: { token: string } }>("/pygmalion/set-token", async (req, reply) => {
    const { token } = req.body ?? {};
    if (!token || typeof token !== "string" || token.length > 8192) {
      return reply.status(400).send({ error: "Invalid token" });
    }
    pygToken = token.trim();
    return { ok: true };
  });

  // ── Search characters on Pygmalion via Connect RPC ──
  app.get<{
    Querystring: {
      q?: string;
      page?: string;
      pageSize?: string;
      orderBy?: string;
      orderDescending?: string;
      tagsInclude?: string;
      tagsExclude?: string;
      includeSensitive?: string;
    };
  }>("/pygmalion/search", async (req) => {
    const {
      q = "",
      page = "0",
      pageSize = "48",
      orderBy = "downloads",
      orderDescending = "true",
      tagsInclude,
      tagsExclude,
      includeSensitive = "false",
    } = req.query;

    const message: Record<string, unknown> = {
      query: q,
      orderBy,
      orderDescending: orderDescending === "true",
      pageSize: parseInt(pageSize) || 48,
      page: parseInt(page) || 0,
    };

    if (tagsInclude) {
      message.tagsNamesInclude = tagsInclude.split(",").map((t) => t.trim()).filter(Boolean);
    }
    if (tagsExclude) {
      message.tagsNamesExclude = tagsExclude.split(",").map((t) => t.trim()).filter(Boolean);
    }

    // Authenticated search with NSFW
    if (includeSensitive === "true" && pygToken) {
      message.includeSensitive = true;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${PYGMALION_API_BASE}/CharacterSearch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${pygToken}`,
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Pygmalion search error ${res.status}`);
        return res.json();
      } finally {
        clearTimeout(timeout);
      }
    }

    // Unauthenticated GET — public SFW results only
    const params = new URLSearchParams({
      connect: "v1",
      encoding: "json",
      message: JSON.stringify(message),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${PYGMALION_API_BASE}/CharacterSearch?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Pygmalion search error ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Get full character detail from Pygmalion ──
  app.get<{
    Querystring: {
      id: string;
      versionId?: string;
    };
  }>("/pygmalion/character", async (req) => {
    const { id, versionId } = req.query;
    if (!id) throw new Error("Missing character id");

    const message: Record<string, unknown> = { characterMetaId: id };
    if (versionId) message.characterVersionId = versionId;

    // Authenticated detail fetch (needed for NSFW characters)
    if (pygToken) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${PYGMALION_API_BASE}/Character`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${pygToken}`,
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Pygmalion character fetch error ${res.status}`);
        return res.json();
      } finally {
        clearTimeout(timeout);
      }
    }

    const params = new URLSearchParams({
      connect: "v1",
      encoding: "json",
      message: JSON.stringify(message),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${PYGMALION_API_BASE}/Character?${params}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Pygmalion character fetch error ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  });

  // ── Proxy Pygmalion avatar images ──
  app.get<{ Params: { "*": string } }>("/pygmalion/avatar/*", async (req, reply) => {
    const assetPath = (req.params as Record<string, string>)["*"];
    if (!assetPath) throw new Error("Missing asset path");

    const url = assetPath.startsWith("http") ? assetPath : `${PYGMALION_ASSETS_BASE}/${assetPath}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return reply.status(404).send({ error: "Avatar not found" });
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") || "image/webp";
      return reply.header("Content-Type", ct).header("Cache-Control", "public, max-age=86400").send(buf);
    } finally {
      clearTimeout(timeout);
    }
  });
}
