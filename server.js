// server.js — KIE backend (fixed endpoints) + browser diagnostics
// ENV: KIE_KEY (required), KIE_API_PREFIX (default https://api.kie.ai/api/v1)
//      CORS_ORIGIN (*), PORT (8080), CONCURRENCY (1)
// Open in browser after deploy:  /health  /stats  /diagnostics

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

// ---------- health / stats
const started = Date.now();
let active = 0; const queue = [];
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));
app.get("/stats", (_req,res)=> res.json({
  ok:true, service:"kie-backend",
  uptime_sec: Math.floor((Date.now()-started)/1000),
  active, queued: queue.length, max_concurrency: MAX,
  api_prefix: API, key_present: !!KEY
}));

// ---------- tiny queue
function enqueue(run){ return new Promise((resolve,reject)=>{ queue.push({run,resolve,reject}); pump(); }); }
async function pump(){
  if(active>=MAX || !queue.length) return;
  active++;
  const job = queue.shift();
  try{ job.resolve(await job.run()); }
  catch(e){ job.reject(e); }
  finally{ active--; setImmediate(pump); }
}

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

// ---------- KIE helpers
const H = { get Authorization(){ return `Bearer ${KEY}`; }, "x-api-key": KEY, "Content-Type":"application/json" };
async function kiePost(path, payload){
  if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, { headers: H, timeout: 600_000 });
  return data;
}
async function kieGetPath(pathWithId){
  if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
  const url = `${API}${pathWithId}`;
  const { data } = await axios.get(url, { headers: H, timeout: 60_000 });
  return data;
}
function pickTaskId(sub){
  return sub?.id || sub?.taskId || sub?.data?.id || sub?.data?.taskId || sub?.job_id || null;
}

// ---------- definitive endpoints (corrected)
const SUBMIT_PATH = "/video/generations";          // POST
const STATUS_PATH = "/video/generations";          // GET /video/generations/:id
// keep one legacy fallback that sometimes answers (422 without model)
const FALLBACK_SUBMIT = "/veo/generate";

// submit -> returns task id
async function submitToKIE(payload){
  let lastErr;
  // try correct endpoint first
  for(const path of [SUBMIT_PATH, FALLBACK_SUBMIT]){
    try{
      const resp = await enqueue(()=> kiePost(path, payload));
      const id = pickTaskId(resp);
      if(id) return { id, submitPath: path, raw: resp };
      lastErr = new Error(`No taskId from ${path}`); lastErr.raw = resp;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("Submit failed");
}

// poll by PATH PARAM (/video/generations/:id)
async function pollUntil(id){
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r, 3000));
    try{
      const st = await kieGetPath(`${STATUS_PATH}/${id}`);
      if(st?.status === "succeeded" && st?.output?.video_url) return st;
      if(st?.status === "failed"){ const e=new Error(st.error || "Render failed"); e.status=502; e.meta=st; throw e; }
    }catch{ /* keep looping */ }
  }
  const e=new Error("Render timeout"); e.status=504; throw e;
}

// ---------- main handler
async function handleGenerate(req,res){
  const reqId = crypto.randomBytes(5).toString("hex");
  try{
    const tier = (req.body?.tier==="quality") ? "quality" : "fast";
    const body = sanitize(req.body);

    // include model explicitly to satisfy /veo/generate when used
    const payload = { model: "veo-3", mode: tier, ...body };

    const { id, submitPath } = await submitToKIE(payload);
    const done = await pollUntil(id);

    return res.json({
      success:true,
      job_id: id,
      video_url: done.output.video_url,
      meta: done,
      submitPath,
      statusPath: `${STATUS_PATH}/${id}`,
      request_id: reqId
    });
  }catch(err){
    res.status(err.status||500).json({ success:false, error:String(err.message||err), request_id:reqId });
  }
}

// ---------- routes + preflight (iPad/Safari friendly)
app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; handleGenerate(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; handleGenerate(req,res); });
for (const p of ["/generate-fast","/generate-quality"]) {
  app.options(p, (_req,res)=> res.set({
    "Access-Control-Allow-Origin": ORIG,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }).sendStatus(204));
}

// ---------- browser diagnostics (open /diagnostics)
app.get("/diagnostics", async (_req,res)=>{
  const out = {
    api: API, key_present: !!KEY,
    submit_path: SUBMIT_PATH, status_path: STATUS_PATH,
    probe: {}
  };
  if(KEY){
    try{
      const sample = { model:"veo-3", mode:"fast", prompt:"diagnostic test", duration:1, aspect_ratio:"9:16", with_audio:false };
      const sub = await kiePost(SUBMIT_PATH, sample);
      const id  = pickTaskId(sub);
      out.probe.submit_ok = !!id;
      out.probe.submit_raw = !!id ? undefined : sub;
      if(id){
        // single quick status check (no loop) just to confirm 200
        try{
          const st = await kieGetPath(`${STATUS_PATH}/${id}`);
          out.probe.status_ping_ok = true;
          out.probe.status = { id, status: st?.status || null };
        }catch(e){ out.probe.status_ping_ok = false; out.probe.status_err = e?.response?.status || String(e); }
      }
    }catch(e){ out.probe.submit_ok = false; out.probe.submit_err = e?.response?.status || String(e); }
  }
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(out, null, 2));
});

app.listen(PORT, ()=> console.log(`🚀 KIE backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
