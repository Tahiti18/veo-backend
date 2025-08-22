// server.js — Veo3 backend with resilient URL extraction + late fetch
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

// ---------- tiny queue
let active=0; const q=[];
function enqueue(run){ return new Promise((resolve,reject)=>{ q.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX||!q.length) return; active++; const j=q.shift(); try{ j.resolve(await j.run()); }catch(e){ j.reject(e); }finally{ active--; setImmediate(pump); } }

// ---------- health
const boot=Date.now();
app.get("/", (_req,res)=>res.json({ok:true,service:"kie-backend",time:new Date().toISOString()}));
app.get("/health", (_req,res)=>res.json({ok:true,api_prefix:API,kie_key_present:!!KEY}));
app.get("/stats", (_req,res)=>res.json({ok:true,uptime_sec:Math.floor((Date.now()-boot)/1000),active,queued:q.length,max_concurrency:MAX}));

// ---------- helpers
function headers(){ return { Authorization:`Bearer ${KEY}`, "Content-Type":"application/json" }; }
async function postGenerate(payload){
  const { data } = await axios.post(`${API}/veo/generate`, payload, { headers: headers(), timeout: 600_000 });
  return data; // { code, data: { taskId } }
}
async function getStatus(taskId){
  const { data } = await axios.get(`${API}/veo/record-info`, { params:{ taskId }, headers: headers(), timeout: 60_000 });
  return data; // { code, data: {...} }
}
// grab first usable URL no matter how KIE formats it
function pickUrl(stData){
  if(!stData) return null;
  const candidates = [];
  const push = v => { if(typeof v === "string" && /^https?:\/\//.test(v)) candidates.push(v); };
  // resultUrls may be JSON string
  if (typeof stData.resultUrls === "string") {
    try { JSON.parse(stData.resultUrls).forEach(push); } catch {}
  }
  if (Array.isArray(stData.resultUrls)) stData.resultUrls.forEach(push);
  if (stData.resultUrl) push(stData.resultUrl);
  if (stData.videoUrl) push(stData.videoUrl);
  if (stData.url) push(stData.url);
  // sometimes nested
  if (stData.output?.video_url) push(stData.output.video_url);
  return candidates[0] || null;
}
const RATIOS=new Set(["16:9","9:16","1:1","4:3","3:4"]);
function normalize(b={}){
  const { prompt, aspect_ratio, aspectRatio, seed, style, negative_prompt, with_audio, audio } = b;
  if(!prompt||!String(prompt).trim()){ const e=new Error("Prompt is required"); e.status=400; throw e; }
  const ar = RATIOS.has(String(aspectRatio||aspect_ratio)) ? String(aspectRatio||aspect_ratio) : "16:9";
  const out = { prompt:String(prompt), aspectRatio:ar };
  if(style) out.prompt += `, ${String(style)}`;
  if(negative_prompt) out.prompt += `, avoid: ${String(negative_prompt)}`;
  if(seed!==undefined) out.seed=seed;
  if(with_audio===false || audio===false) out.withAudio=false;
  return out;
}

// poll until success AND a real URL is present (grace checks after success)
async function pollForUrl(taskId){
  // up to ~10 minutes total
  for (let i=0;i<200;i++){
    await new Promise(r=>setTimeout(r,3000));
    const st = await enqueue(()=> getStatus(taskId));
    if (st?.code === 200 && st?.data) {
      const flag = st.data.successFlag;
      const url = pickUrl(st.data);
      if (flag === 1 && url) return { url, raw: st };
      if (flag === 2 || flag === 3) { const e=new Error("Render failed"); e.status=502; e.meta=st; throw e; }
      // if succeeded but url not ready, keep looping a bit longer
      if (flag === 1 && !url) continue;
    }
  }
  const e=new Error("Result URL not available yet"); e.status=504; throw e;
}

// cache for late retrieval within process lifetime
const RESULT_CACHE = new Map(); // taskId -> url

async function generateHandler(req,res){
  const request_id = crypto.randomBytes(5).toString("hex");
  try{
    if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
    const tier = req.body?.tier === "quality" ? "quality" : "fast";
    const model = tier === "quality" ? "veo3" : "veo3_fast";
    const payload = { model, ...normalize(req.body) };

    const sub = await enqueue(()=> postGenerate(payload));
    if(!(sub && sub.code === 200 && sub.data?.taskId)){
      const e = new Error(sub?.msg || "No job id from KIE"); e.status=502; e.meta=sub; throw e;
    }
    const taskId = sub.data.taskId;

    // start polling; if URL arrives, return it; else return pending so UI can fall back to /result/:id
    try{
      const done = await pollForUrl(taskId);
      RESULT_CACHE.set(taskId, done.url);
      return res.json({ success:true, job_id:taskId, video_url: done.url, meta: done.raw, request_id });
    }catch(err){
      // fall back: return pending with job id (credits already spent)
      return res.status(202).json({ success:true, pending:true, job_id:taskId, request_id, note:"URL not ready yet; poll /result/"+taskId });
    }
  }catch(err){
    res.status(err.status||500).json({ success:false, error:String(err.message||err), request_id });
  }
}

app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; generateHandler(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; generateHandler(req,res); });

for (const p of ["/generate-fast","/generate-quality"]) {
  app.options(p, (_req,res)=> res.set({
    "Access-Control-Allow-Origin": ORIG,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }).sendStatus(204));
}

// Late retrieval endpoint for the frontend
app.get("/result/:id", async (req,res)=>{
  const id = req.params.id;
  try{
    if (RESULT_CACHE.has(id)) return res.json({ ok:true, job_id:id, video_url: RESULT_CACHE.get(id), cached:true });
    const st = await getStatus(id);
    if (st?.code === 200 && st?.data) {
      const url = pickUrl(st.data);
      if (url){ RESULT_CACHE.set(id, url); return res.json({ ok:true, job_id:id, video_url:url, cached:false }); }
      const flag = st.data.successFlag;
      if (flag === 2 || flag === 3) return res.status(502).json({ ok:false, error:"Render failed", meta:st });
    }
    res.status(202).json({ ok:true, pending:true, job_id:id });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

app.listen(PORT, ()=> console.log(`🚀 KIE Veo3 backend LIVE on ${PORT} | CONCURRENCY=${MAX}`));
