// server.js — KIE-only backend (Railway-safe, limiter OFF by default)
// ENV: KIE_KEY (required)
//      KIE_API_PREFIX? (default https://api.kie.ai/api/v1)
//      CORS_ORIGIN? (default *)
//      CONCURRENCY? (default 2)
//      RATE_LIMIT_MAX? (0 = disabled)  RATE_LIMIT_WINDOW_MS? (default 60000)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const API  = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY  = process.env.KIE_KEY;
const ORIGIN = process.env.CORS_ORIGIN || "*";

// ---------------- core middleware
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: "2mb" }));

// ---------------- configurable rate guard (OFF by default)
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000); // 60s
const RATE_MAX    = Number(process.env.RATE_LIMIT_MAX || 0);           // 0 means disabled
const RL_BUCKET = new Map();
app.use((req,res,next)=>{
  if (!RATE_MAX || RATE_MAX <= 0) return next(); // disabled
  const ip  = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "local";
  const now = Date.now();
  const arr = (RL_BUCKET.get(ip) || []).filter(ts => now - ts < RATE_WINDOW);
  arr.push(now);
  RL_BUCKET.set(ip, arr);
  if (arr.length > RATE_MAX) {
    return res.status(429).json({ success:false, error:"Rate limit exceeded", limit: RATE_MAX, window_ms: RATE_WINDOW });
  }
  next();
});

// ---------------- health
app.get("/", (_req, res) => res.json({ status: "✅ Kie.ai backend running", version: "2.4.0", time: new Date().toISOString() }));
app.get("/health", (_req,res) => res.json({ ok:true, service:"kie-backend", api_prefix: API, kie_key_present: Boolean(KEY) }));

// ---------------- concurrency queue
const MAX = Math.max(1, Number(process.env.CONCURRENCY || 2));
let active = 0;
const queue = [];
const stats = () => ({ max: MAX, active, queued: queue.length });
app.get("/stats", (_req,res)=> res.json({ ok:true, ...stats() }));
function enqueue(run) {
  return new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); tick(); });
}
async function tick() {
  if (active >= MAX) return;
  const next = queue.shift();
  if (!next) return;
  active++;
  try { next.resolve(await next.run()); }
  catch (e) { next.reject(e); }
  finally { active--; setImmediate(tick); }
}

// ---------------- helpers
const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const ALLOWED_RES    = new Set(["720p", "1080p"]); // extend if your KIE plan supports more
const clamp = d => { const n = Number(d); if(!Number.isFinite(n)) return 8; return Math.max(1, Math.min(8, Math.round(n*10)/10)); };

function sanitize(body = {}) {
  const { prompt, duration, fps, aspect_ratio, seed, with_audio, resolution, style, negative_prompt } = body;
  if (!prompt || !String(prompt).trim()) { const e=new Error("Prompt is required."); e.status=400; throw e; }
  const out = {
    prompt: String(prompt),
    duration: clamp(duration ?? 8),                 // numeric seconds
    fps: Number.isFinite(Number(fps)) ? Number(fps) : 30,
    aspect_ratio: ALLOWED_RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "9:16",
    seed: seed ?? 42101,
    with_audio: with_audio === false ? false : true // default true
  };
  if (resolution && ALLOWED_RES.has(String(resolution))) out.resolution = String(resolution);
  if (style && String(style).trim()) out.style = String(style).trim();
  if (negative_prompt && String(negative_prompt).trim()) out.negative_prompt = String(negative_prompt).trim();
  return out;
}

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

function resolveEndpoints(model="veo", tier="fast"){
  if (model === "veo")    return { submit:"/veo/generate",    status:"/veo/record-info",    payload:{ mode: tier==="quality" ? "quality" : "fast" }, tag:`kie.veo3.${tier}` };
  if (model === "runway") return { submit:"/runway/generate", status:"/runway/record-info", payload:{}, tag:"kie.runway" };
  const e=new Error('Invalid model. Use "veo" or "runway".'); e.status=400; throw e;
}

// ---------------- core handler
async function handleGenerate(req, res) {
  const request_id = crypto.randomBytes(6).toString("hex");
  try {
    const { model="veo", tier="fast", callback_url } = req.body || {};
    const p  = sanitize(req.body);
    const ep = resolveEndpoints(model, tier);

    // submit
    const sub = await enqueue(() => kiePost(ep.submit, { ...ep.payload, ...p, ...(callback_url ? { callback_url } : {}) }));
    const jobId = sub.id || sub.job_id;
    if (!jobId) return res.status(502).json({ success:false, error:"No job id from KIE", raw: sub, request_id });

    // async path
    if (callback_url) return res.json({ success:true, enqueued:true, job_id: jobId, model, tier, request_id, queue: stats() });

    // sync poll
    const done = await enqueue(() => pollUntil(ep.status, jobId));
    return res.json({ success:true, provider: ep.tag, video_url: done.output.video_url, job_id: jobId, meta: done, request_id, queue: stats() });
  } catch (err) {
    console.error(`[${request_id}] GENERATE ERROR:`, err.status || "", err.message);
    res.status(err.status || 500).json({ success:false, error: err.message, request_id });
  }
}

// ---------------- routes
app.post("/generate", handleGenerate);
app.post("/generate-fast",   (req,res)=>{ req.body = { ...req.body, model:"veo", tier:"fast"    }; handleGenerate(req,res); });
app.post("/generate-quality",(req,res)=>{ req.body = { ...req.body, model:"veo", tier:"quality" }; handleGenerate(req,res); });
app.post("/generate-runway", (req,res)=>{ req.body = { ...req.body, model:"runway"            }; handleGenerate(req,res); });

// ---- debug (does NOT hit KIE): see sanitized payload without spending credits
app.post("/debug/sanitize", (req,res)=>{
  try { res.json({ ok:true, payload: sanitize(req.body) }); }
  catch(e){ res.status(e.status||400).json({ ok:false, error:e.message }); }
});

// ---- webhook placeholder
app.post("/webhook/kie", (req, res) => {
  console.log("Webhook KIE:", req.body?.id, req.body?.status, req.body?.output?.video_url || "");
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🚀 Kie backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
