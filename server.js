// server.js — KIE-only backend (ESM) with webhooks + unified generate
// ENV: KIE_KEY (required), KIE_API_PREFIX (default https://api.kie.ai/api/v1), PORT
//      CORS_ORIGIN (optional, e.g. https://justfomo.com)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const API = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY = process.env.KIE_KEY;
const ORIGIN = process.env.CORS_ORIGIN || "*";

// ---------- middleware
app.use(cors({ origin: ORIGIN, credentials: false }));
app.use(express.json({ limit: "2mb" }));

// tiny rate cap: 30 requests / 60s per ip
const BUCKET = new Map();
app.use((req,res,next)=>{
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "local";
  const now = Date.now();
  const w = BUCKET.get(ip) || [];
  const w2 = w.filter(t=> now - t < 60_000);
  w2.push(now);
  BUCKET.set(ip, w2);
  if (w2.length > 30) return res.status(429).json({ success:false, error:"Rate limit exceeded" });
  next();
});

// ---------- health & root
app.get("/", (_req, res) =>
  res.json({ status: "✅ Kie.ai backend running", version: "2.1.0", time: new Date().toISOString() })
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "kie-backend", api_prefix: API, kie_key_present: Boolean(KEY) })
);

// ---------- helpers
const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const clamp = d => { const n=Number(d); if(!Number.isFinite(n)) return 8; return Math.max(1, Math.min(8, Math.round(n*10)/10)); };

function sanitize(body = {}) {
  const { prompt, duration, fps, aspect_ratio, seed, with_audio } = body;
  if (!prompt || !String(prompt).trim()) { const e=new Error("Prompt is required."); e.status=400; throw e; }
  return {
    prompt: String(prompt),
    duration: clamp(duration ?? 8),
    fps: Number.isFinite(Number(fps)) ? Number(fps) : 30,
    aspect_ratio: ALLOWED_RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "9:16",
    seed: seed ?? 42101,
    with_audio: with_audio === false ? false : true
  };
}
const rid = () => crypto.randomBytes(6).toString("hex");

async function kiePost(path, payload){
  if (!KEY) { const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    timeout: 600_000
  });
  return data;
}
async function kieGet(path, params){
  const url = `${API}${path}`;
  const { data } = await axios.get(url, {
    params, headers: { Authorization: `Bearer ${KEY}` }, timeout: 60_000
  });
  return data;
}
async function pollUntil(path, id){
  for (let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r, 3000));
    const data = await kieGet(path, { id });
    if (data.status === "succeeded" && data.output?.video_url) return data;
    if (data.status === "failed") { const e=new Error(data.error || "Render failed"); e.status=502; e.meta=data; throw e; }
  }
  const e=new Error("Render timeout"); e.status=504; throw e;
}

// map model/tier → kie endpoints
function endpoints({ model="veo", tier="fast" }){
  if (model === "veo") {
    return { submit: "/veo/generate", status: "/veo/record-info", payload: { mode: tier === "quality" ? "quality" : "fast" } };
  }
  if (model === "runway") {
    return { submit: "/runway/generate", status: "/runway/record-info", payload: {} };
  }
  const e=new Error('Invalid model. Use "veo" or "runway".'); e.status=400; throw e;
}

// ---------- Unified generate (supports callback_url to avoid polling)
app.post("/generate", async (req, res) => {
  const request_id = rid();
  try {
    const { model="veo", tier="fast", callback_url } = req.body || {};
    const p = sanitize(req.body);
    const ep = endpoints({ model, tier });

    const sub = await kiePost(ep.submit, { ...ep.payload, ...p, ...(callback_url ? { callback_url } : {}) });
    const jobId = sub.id || sub.job_id;
    if (!jobId) return res.status(502).json({ success:false, error:"No job id from KIE", raw: sub, request_id });

    // If callback_url provided, return immediately (no polling)
    if (callback_url) {
      return res.json({ success:true, enqueued:true, job_id: jobId, model, tier, request_id });
    }

    // Otherwise poll until done
    const done = await pollUntil(ep.status, jobId);
    return res.json({
      success: true,
      provider: model === "veo" ? `kie.veo3.${tier}` : "kie.runway",
      video_url: done.output.video_url,
      job_id: jobId,
      meta: done,
      request_id
    });
  } catch (err) {
    console.error(`[${request_id}] GENERATE ERROR:`, err.status || "", err.message);
    res.status(err.status || 500).json({ success:false, error: err.message, request_id, meta: err.meta });
  }
});

// ---------- Legacy convenience routes (still available)
app.post("/generate-fast", (req, res)=> { req.body.model="veo"; req.body.tier="fast"; return app._router.handle(req,res,()=>{}); });
app.post("/generate-quality", (req, res)=> { req.body.model="veo"; req.body.tier="quality"; return app._router.handle(req,res,()=>{}); });
app.post("/generate-runway", (req, res)=> { req.body.model="runway"; return app._router.handle(req,res,()=>{}); });

// ---------- Status proxy (useful for jobs with callback_url)
app.get("/status/:id", async (req, res) => {
  const request_id = rid();
  try {
    const model = (req.query.model || "veo").toString();
    const ep = endpoints({ model, tier:"fast" }); // tier not needed for status
    const data = await kieGet(ep.status, { id: req.params.id });
    res.json({ success:true, request_id, model, data });
  } catch (err) {
    console.error(`[${request_id}] STATUS ERROR:`, err.status || "", err.message);
    res.status(err.status || 500).json({ success:false, error: err.message, request_id });
  }
});

// ---------- Webhook receiver (KIE → you). Optional: protect with a secret.
app.post("/webhook/kie", (req, res) => {
  // Expect body from KIE like: { id, status, output:{ video_url }, ... }
  // Store to DB / trigger your pipeline here.
  console.log("Webhook KIE:", req.body?.id, req.body?.status, req.body?.output?.video_url || "");
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🚀 Kie backend (LIVE) on ${PORT}`));
