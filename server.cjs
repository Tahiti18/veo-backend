// server.cjs — baseline + ElevenLabs voices (read-only)
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- helpers ----
const ELEVEN_KEY = process.env.ELEVEN_LABS || process.env.ELEVENLABS_API_KEY || "";
const withTimeout = async (promise, ms = 8000, label = "request") => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await promise(ac.signal);
  } finally {
    clearTimeout(t);
  }
};

// ---- health + ping ----
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/health-eleven", (_req, res) => {
  res.json({ ok: true, elevenKeyPresent: !!ELEVEN_KEY, ts: new Date().toISOString() });
});

// ---- ElevenLabs voices (read-only) ----
app.get("/api/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing (set ELEVEN_LABS or ELEVENLABS_API_KEY)" });
  try {
    const r = await withTimeout(
      (signal) => fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY }, signal }),
      8000,
      "voices"
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices || []).map(v => ({
      id: v.voice_id || v.voiceId || v.id,
      name: v.name,
      category: v.category || ""
    }));
    res.json({ voices });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Voices request timed out" : (e?.message || String(e));
    res.status(502).json({ error: msg });
  }
});

// ---- start ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`[OK] Listening on ${PORT}`));
