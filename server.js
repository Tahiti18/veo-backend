// server.js — KIE backend with browser diagnostics (no console required)
// ENV: KIE_KEY (required)
//      KIE_API_PREFIX (default https://api.kie.ai/api/v1)
//      CORS_ORIGIN (default *), PORT (default 8080), CONCURRENCY (default 1)
//      KIE_SUBMIT_PATHS, KIE_STATUS_PATHS (optional comma lists to override)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app   = express();
const PORT  = process.env.PORT || 8080;
const ORIG  = process.env.CORS_ORIGIN || "*";
const API   = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY   = process.env.KIE_KEY;
const MAX   = Math.max(1, Number(process.env.CONCURRENCY || 1));

app.use(cors({ origin: ORIG }));
app.use(express.json({ limit: "2mb" }));

// ---------- health
const started = Date.now();
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));
app.get("/stats", (_req,res)=> res.json({
  ok:true,
  service:"kie-backend",
  uptime_sec: Math.floor((Date.now()-started)/1000),
  active, queued: queue.length, max_concurrency: MAX,
  api_prefix: API, key_present: !!KEY
}));

// ---------- tiny queue
let active = 0; const queue = [];
function enqueue(run){ return new Promise((resolve,reject)=>{ queue.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX||!queue.length) return; active++; const j=queue.shift(); try{ j.resolve(await j.run()); }catch(e){ j.reject(e); }finally{ active--; setImmediate(pump); } }

// ---------- input guard
const RATIOS = new Set(["16:9","9:16","1:1","4:3","3:4"]);
const RES    = new Set(["720p","1080p"]);
const clamp  = s => Math.max(1, Math.min(8, Math.round(Number(s||8)*10)/10));
function sanitize(b={}){
  const { prompt, duration, aspect_ratio, with_audio, audio, resolution, style, negative_prompt, seed } = b;
  if(!prompt || !String(prompt).trim()){ const e=new Error("Prompt is required"); e.status=400; throw e; }
  const out = {
    prompt: String(prompt),
    duration: clamp(duration),
    aspect_ratio: RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "9:16",
    with_audio: (with_audio!==undefined ? with_audio : audio)!==false
  };
  if (resolution && RES.has(String(resolution))) out.resolution = String(resolution);
  if (style && String(style).trim()) out.style = String(style).trim();
  if (negative_prompt && String(negative_prompt).trim()) out.negative_prompt = String(negative_prompt).trim();
  if (seed !== undefined) out.seed = seed;
  return out;
}

// ---------- KIE helpers (try both Authorization and x-api-key)
function kieHeaders(){
  return { Authorization: `Bearer ${KEY}`, "x-api-key": KEY, "Content-Type":"application/json" };
}
async function kiePost(path, payload){
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, { headers: kieHeaders(), timeout: 600_000 });
  return data;
}
async function kieGet(path, params){
  const url = `${API}${path}`;
  const { data } = await axios.get(url, { params, headers: kieHeaders(), timeout: 60_000 });
  return data;
}
function pickTaskId(sub){
  return sub?.data?.taskId || sub?.taskId || sub?.data?.id || sub?.id || sub?.job_id || sub?.result?.taskId || null;
}

// ---------- candidate paths (override with env if needed)
const SUBMIT_PATHS = (process.env.KIE_SUBMIT_PATHS?.split(",").map(s=>s.trim()).filter(Boolean)) ||
[
  "/veo3/generate",
  "/veo/generate",
  "/video/generate",
  "/video/gen",
  "/videos/generate"
];
const STATUS_PATHS = (process.env.KIE_STATUS_PATHS?.split(",").map(s=>s.trim()).filter(Boolean)) ||
[
  "/veo3/record-info",
  "/veo/record-info",
  "/video/status",
  "/videos/status",
  "/job/status"
];

// ---------- submit + poll
async function trySubmit(payload){
  let lastErr = null;
  for(const p of SUBMIT_PATHS){
    try{
      const resp = await enqueue(()=> kiePost(p, payload));
      const taskId = pickTaskId(resp);
      if(taskId) return { taskId, submitPath: p, raw: resp };
      lastErr = new Error(`No taskId in response for ${p}`);
      lastErr.raw = resp;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("All submit attempts failed");
}

async function pollAny(taskId){
  const paramVariants = [ { taskId }, { id: taskId }, { task_id: taskId }, { job_id: taskId } ];
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r,3000));
    for(const path of STATUS_PATHS){
      for(const pv of paramVariants){
        try{
          const st = await kieGet(path, pv);
          if(st?.status==="succeeded" && st?.output?.video_url) return { st, statusPath:path, params: pv };
          if(st?.status==="failed"){ const e=new Error(st.error||"Render failed"); e.status=502; e.meta=st; throw e; }
        }catch{ /* keep probing */ }
      }
    }
  }
  const e=new Error("Render timeout"); e.status=504; throw e;
}

// ---------- main handler
async function handleGenerate(req,res){
  const reqId = crypto.randomBytes(5).toString("hex");
  try{
    if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
    const tier = (req.body?.tier==="quality") ? "quality" : "fast";
    const body = sanitize(req.body);
    const payload = { mode: tier, ...body };

    const { taskId, submitPath } = await trySubmit(payload);
    if(!taskId) return res.status(502).json({ success:false, error:"No job id from KIE", request_id:reqId });

    const { st, statusPath } = await pollAny(taskId);
    return res.json({
      success:true,
      job_id: taskId,
      video_url: st.output.video_url,
      meta: st,
      submitPath, statusPath,
      request_id: reqId
    });
  }catch(err){
    res.status(err.status||500).json({ success:false, error:String(err.message||err), request_id:reqId });
  }
}

// ---------- routes
app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; handleGenerate(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; handleGenerate(req,res); });

// Preflight for browsers/iPad
app.options("/generate-fast",    (_req,res)=> res.set({
  "Access-Control-Allow-Origin": ORIG,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
}).sendStatus(204));
app.options("/generate-quality", (_req,res)=> res.set({
  "Access-Control-Allow-Origin": ORIG,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
}).sendStatus(204));

// ---------- browser diagnostics page (open /diagnostics in Safari)
app.get("/diagnostics", async (_req,res)=>{
  const result = { api: API, key_present: !!KEY, submit_paths: SUBMIT_PATHS, status_paths: STATUS_PATHS, probes: [] };
  // probe submit paths with a dry-run prompt (short)
  if(KEY){
    for(const p of SUBMIT_PATHS){
      try{
        const data = await kiePost(p, { mode:"fast", prompt:"diagnostic test", duration:1, aspect_ratio:"9:16", with_audio:false });
        result.probes.push({ submit:p, taskId: pickTaskId(data) || null, ok: !!pickTaskId(data), raw: data });
        if (result.probes.at(-1).ok) break;
      }catch(e){ result.probes.push({ submit:p, ok:false, err: e?.response?.status || e.message }); }
    }
  }
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(result, null, 2));
});

app.listen(PORT, ()=> console.log(`🚀 KIE backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
