// routes/eleven.safe.cjs
// CommonJS, Node >= 18 (uses global fetch). No file writes. No static. No ffmpeg.
// Adds: GET /api/health-eleven, GET /api/eleven/voices

const ELEVEN_KEY = process.env.ELEVEN_LABS || process.env.ELEVENLABS_API_KEY || "";

module.exports = function attachEleven(app) {
  // module health
  app.get("/api/health-eleven", (_req, res) => {
    res.json({
      ok: true,
      elevenKeyPresent: !!ELEVEN_KEY,
      ts: new Date().toISOString()
    });
  });

  // List voices
  app.get("/api/eleven/voices", async (_req, res) => {
    if (!ELEVEN_KEY) {
      return res.status(401).json({ error: "ElevenLabs key missing (set ELEVEN_LABS or ELEVENLABS_API_KEY)" });
    }
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": ELEVEN_KEY }
      });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json(j);

      const voices = (j.voices || []).map(v => ({
        id: v.voice_id || v.voiceId || v.id,
        name: v.name,
        category: v.category || ""
      }));
      res.json({ voices });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
};
