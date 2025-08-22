// server.js — KIE backend with /triage + generate endpoints
// ENV required in Railway Variables:
//   KIE_KEY
// Optional:
//   KIE_API_PREFIX="https://api.kie.ai/api/v1"
//   CORS_ORIGIN="*"
//   PORT="8080"
//   CONCURRENCY="1"
//   KIE_SUBMIT_PATHS, KIE_STATUS_PATHS (comma lists if you want to override)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 8080;
const ORIG = process.env.CORS_ORIGIN || "*";
const API  = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY  = process.env.KIE_KEY;
const MAX  = Math.max(1, Number(process.env.CONCURRENCY || 1));

app.use(cors({ origin: ORIG }));
app.use(express.json({ limit: "2mb" }));

// ---------- queue ----------
let active = 0; const queue = [];
function enqueue(run){ return new Promise((resolve,reject)=>{ queue.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX || !queue.length) return; active++; const j=queue.shift(); try{ j.resolve(await j.run()); }catch(e){ j.reject(e); }finally{ active--; setImmediate(pump); } }

// ---------- health ----------
const boot = Date.now();
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));
app.get("/stats", (_req,res)=> res.json({
  ok:true, service:"kie-backend",
  uptime_sec: Math.floor((Date.now()-boot)/1000),
  active, queued: queue.length, max_concurrency: MAX,
  api_prefix: API, key_present: !!KEY
}));

// ---------- helpers ----------
function headers(){
  return { Authorization:`Bearer ${KEY}`, "x-api-key": KEY, "Content-Type":"application/json" };
}
async function kiePost(path, payload){
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, { headers: headers(), timeout: 600_000 });
  return data;
}
async function kieGet(path, params){
  const url = `${API}${path}`;
  const { data } = await axios.get(url, { params, headers: headers(), timeout: 60_000 });
  return data;
}
function pickTaskId(x){
  return x?.taskId || x?.data?.taskId || x?.id || x?.data?.id || x?.job_id || x?.result?.taskId || null;
}

// ---------- sanitize ----------
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
  if(resolution && RES.has(String(resolution))) out.resolution = String(resolution);
  if(style && String(style).trim()) out.style = String(style).trim();
  if(negative_prompt && String(negative_prompt).trim()) out.negative_prompt = String(negative_prompt).trim();
  if(seed !== undefined) out.seed = seed;
  return out;
}

// ---------- triage ----------
let DETECT = { submit_path:null, status_path:null, last_err:null };

const SUBMIT_CANDIDATES = (process.env.KIE_SUBMIT_PATHS?.split(",").map(s=>s.trim())) || [
  "/veo/generate",
  "/veo3/generate",
  "/video/generate",
  "/video/generations",
  "/videos/generate",
  "/videos/generations",
  "/jobs/create"
];

const STATUS_CANDIDATES = (process.env.KIE_STATUS_PATHS?.split(",").map(s=>s.trim())) || [
  "/veo/record-info",
  "/veo3/record-info",
  "/video/status",
  "/videos/status",
  "/video/generations",
  "/videos/generations",
  "/job/status",
  "/jobs/status"
];

async function detectPaths(){
  const probeBody = { model:"veo-3", mode:"fast", prompt:"probe", duration:1, aspect_ratio:"9:16", with_audio:false };
  let submit_path = null; let last = null;

  for(const p of SUBMIT_CANDIDATES){
    try{
      const data = await enqueue(()=> kiePost(p, probeBody));
      const id = pickTaskId(data);
      if(id){ submit_path = p; last = { ok:true, id }; break; }
      last = { ok:false, err:"no taskId", raw:data };
    }catch(e){ last = { ok:false, err:e?.response?.status || e.message }; }
  }
  if(!submit_path){ DETECT = { submit_path:null, status_path:null, last_err:last }; return DETECT; }

  let status_path = null;
  const idForStatus = last.id || "dummy";
  const paramVariants = [ { taskId:idForStatus }, { id:idForStatus }, { task_id:idForStatus }, { job_id:idForStatus } ];
  for(const sp of STATUS_CANDIDATES){
    for(const pv of paramVariants){
      try{
        await enqueue(()=> kieGet(sp, pv));
        status_path = sp; break;
      }catch{/* keep trying */}
    }
    if(status_path) break;
  }
  DETECT = { submit_path, status_path, last_err:null };
  return DETECT;
}

app.get("/triage", async (_req,res)=>{
  if(!KEY){ return res.status(500).json({ ok:false, error:"Missing KIE_KEY" }); }
  const reset = _req.query.reset;
  if(reset){ DETECT = { submit_path:null, status_path:null, last_err:null }; }
  const detected = await detectPaths();
  res.json({ api:API, key_present:!!KEY, detected });
});

// ---------- generation ----------
async function generateHandler(req,res){
  const request_id = crypto.randomBytes(5).toString("hex");
  try{
    if(!KEY){ throw new Error("Missing KIE_KEY"); }

    if(!DETECT.submit_path){
      await detectPaths();
      if(!DETECT.submit_path){ const e=new Error("No working KIE submit path found. Open /triage first."); e.status=502; throw e; }
    }

    const tier = req.body?.tier==="quality" ? "quality" : "fast";
    const body = sanitize(req.body);
    const payload = { model:"veo-3", mode:tier, ...body };

    const sub = await enqueue(()=> kiePost(DETECT.submit_path, payload));
    const taskId = pickTaskId(sub);
    if(!taskId){ const e=new Error("No job id from KIE"); e.status=502; e.meta=sub; throw e; }

    const statusPaths = DETECT.status_path ? [DETECT.status_path] : STATUS_CANDIDATES;
    const paramVariants = [ { taskId:taskId }, { id:taskId }, { task_id:taskId }, { job_id:taskId } ];

    for(let i=0;i<120;i++){
      await new Promise(r=>setTimeout(r, 3000));
      for(const sp of statusPaths){
        for(const pv of paramVariants){
          try{
            const st = await enqueue(()=> kieGet(sp, pv));
            if(st?.status==="succeeded" && st?.output?.video_url){
              return res.json({ success:true, job_id:taskId, video_url:st.output.video_url, meta:st, request_id });
            }
            if(st?.status==="failed"){ const e=new Error(st.error || "Render failed"); e.status=502; e.meta=st; throw e; }
          }catch{/* ignore */}
        }
      }
    }
    const e=new Error("Render timeout"); e.status=504; throw e;
  }catch(err){
    res.status(err.status||500).json({ success:false, error:String(err.message||err), request_id });
  }
}

app.post("/generate-fast",    (req,res)=>{ req.body={...req.body,tier:"fast"}; generateHandler(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body={...req.body,tier:"quality"}; generateHandler(req,res); });

app.options("/generate-fast", (_req,res)=> res.set({
  "Access-Control-Allow-Origin": ORIG,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
}).sendStatus(204));
app.options("/generate-quality", (_req,res)=> res.set({
  "Access-Control-Allow-Origin": ORIG,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
}).sendStatus(204));

app.listen(PORT, ()=> console.log(`🚀 KIE backend LIVE on ${PORT} | CONCURRENCY=${MAX}`));
