// server.js — KIE backend with working routes + preflight + multi-path submit/poll
// ENV: KIE_KEY (required); optional KIE_API_PREFIX (default https://api.kie.ai/api/v1), CORS_ORIGIN, PORT, CONCURRENCY

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

// ------- health
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));

// ------- CORS preflight (important: avoids 404 on OPTIONS)
app.options("/generate-fast", cors());
app.options("/generate-quality", cors());

// ------- tiny queue
let active=0; const q=[];
function enqueue(run){ return new Promise((resolve,reject)=>{ q.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX||!q.length) return; active++; const j=q.shift(); try{ j.resolve(await j.run()); }catch(e){ j.reject(e); }finally{ active--; setImmediate(pump); } }

// ------- input guard
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

// ------- KIE helpers
function authHeaders(){
  if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
  return { Authorization: `Bearer ${KEY}`, "x-api-key": KEY, "Content-Type":"application/json" };
}
async function kiePost(path, payload){
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, { headers: authHeaders(), timeout: 600_000 });
  return data;
}
async function kieGet(path, params){
  const url = `${API}${path}`;
  const { data } = await axios.get(url, { params, headers: authHeaders(), timeout: 60_000 });
  return data;
}
function pickTaskId(sub){
  return sub?.data?.taskId || sub?.taskId || sub?.data?.id || sub?.id || sub?.job_id || sub?.result?.taskId || null;
}

const SUBMIT_PATHS = ["/veo3/generate","/veo/generate","/video/gen"];
const STATUS_PATHS = ["/veo3/record-info","/veo/record-info","/video/status"];

async function trySubmit(payload){
  let last=null;
  for(const p of SUBMIT_PATHS){
    try{
      const resp = await enqueue(()=> kiePost(p, payload));
      const taskId = pickTaskId(resp);
      if(taskId) return { taskId, submitPath:p, raw:resp };
      last = new Error(`No taskId in response for ${p}`); last.meta = resp;
    }catch(e){ last = e; }
  }
  throw last || new Error("All submit attempts failed");
}

async function pollAny(taskId){
  const paramVariants = [ { taskId }, { id: taskId }, { task_id: taskId } ];
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r,3000));
    for(const path of STATUS_PATHS){
      for(const pv of paramVariants){
        try{
          const st = await kieGet(path, pv);
          if(st?.status==="succeeded" && st?.output?.video_url) return { st, statusPath:path, params: pv };
          if(st?.status==="failed"){ const e=new Error(st.error||"Render failed"); e.status=502; e.meta=st; throw e; }
        }catch{ /* keep trying */ }
      }
    }
  }
  const e=new Error("Render timeout"); e.status=504; throw e;
}

// ------- unified handler
async function handleGenerate(req,res){
  const reqId = crypto.randomBytes(5).toString("hex");
  try{
    const tier = (req.body?.tier==="quality")?"quality":"fast";
    const body = sanitize(req.body);
    const payload = { mode: tier, ...body };

    const { taskId, submitPath } = await trySubmit(payload);
    if(!taskId) return res.status(502).json({ success:false, error:"No job id from KIE", request_id:reqId });

    const { st, statusPath } = await pollAny(taskId);
    return res.json({ success:true, job_id:taskId, video_url: st.output.video_url, meta: st, submitPath, statusPath, request_id:reqId });
  }catch(err){
    console.error(`[GEN ${reqId}]`, err.status||"", err.message);
    res.status(err.status||500).json({ success:false, error: err.message, request_id:reqId });
  }
}

// ------- routes your UI calls
app.post("/generate-fast",(req,res)=>{ req.body={...req.body,tier:"fast"};    handleGenerate(req,res); });
app.post("/generate-quality",(req,res)=>{ req.body={...req.body,tier:"quality"}; handleGenerate(req,res); });

app.listen(PORT, ()=> console.log(`🚀 KIE backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
