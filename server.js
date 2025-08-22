// server.js — Veo3-only backend (matches KIE docs)
// ENV (Railway): KIE_KEY (required)
// Optional: KIE_API_PREFIX=https://api.kie.ai/api/v1, CORS_ORIGIN=*, PORT=8080, CONCURRENCY=1

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

// -------- health
const boot = Date.now();
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));
app.get("/stats", (_req,res)=> res.json({
  ok:true, service:"kie-backend",
  uptime_sec: Math.floor((Date.now()-boot)/1000),
  active, queued: queue.length, max_concurrency: MAX,
  api_prefix: API, key_present: !!KEY
}));

// -------- small queue
let active = 0; const queue = [];
function enqueue(run){ return new Promise((resolve,reject)=>{ queue.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX || !queue.length) return; active++; const j=queue.shift(); try{ j.resolve(await j.run()); }catch(e){ j.reject(e); }finally{ active--; setImmediate(pump); } }

// -------- helpers (KIE Veo3)
const RATIOS = new Set(["16:9","9:16","1:1","4:3","3:4"]);
function normalizeBody(b={}){
  const { prompt, aspect_ratio, aspectRatio, imageUrls, seed, style, negative_prompt, with_audio, audio } = b;
  if(!prompt || !String(prompt).trim()){ const e=new Error("Prompt is required"); e.status=400; throw e; }
  // map snake_case -> camelCase expected by KIE
  const ar = RATIOS.has(String(aspectRatio||aspect_ratio)) ? String(aspectRatio||aspect_ratio) : "16:9";
  const out = {
    prompt: String(prompt),
    aspectRatio: ar
  };
  if (Array.isArray(imageUrls) && imageUrls.length) out.imageUrls = imageUrls;
  // ignore unknown fields; KIE Veo3 doesn’t accept duration/fps/etc
  // keep optional extras as part of the prompt
  if (style) out.prompt += `, ${String(style)}`;
  if (negative_prompt) out.prompt += `, avoid: ${String(negative_prompt)}`;
  if (seed !== undefined) out.seed = seed;
  if (with_audio === false || audio === false) out.withAudio = false; // default true on their side
  return out;
}

function headers(){ return { Authorization:`Bearer ${KEY}`, "Content-Type":"application/json" }; }

async function postGenerate(payload){
  const url = `${API}/veo/generate`;
  const { data } = await axios.post(url, payload, { headers: headers(), timeout: 600_000 });
  return data; // expects { code, msg, data: { taskId } }
}
async function getStatus(taskId){
  const url = `${API}/veo/record-info`;
  const { data } = await axios.get(url, { params:{ taskId }, headers: headers(), timeout: 60_000 });
  return data; // expects { code, data: { successFlag, resultUrls } }
}

async function pollUntilDone(taskId){
  for(let i=0;i<160;i++){ // up to ~8 min @ 3s
    await new Promise(r=>setTimeout(r,3000));
    const st = await enqueue(()=> getStatus(taskId));
    if (st?.code === 200 && st?.data){
      const s = st.data.successFlag;
      if (s === 1) {
        // KIE returns resultUrls as a JSON string -> parse
        let urls = [];
        try { urls = JSON.parse(st.data.resultUrls || "[]"); } catch {}
        return { status: "succeeded", urls, raw: st };
      }
      if (s === 2 || s === 3) {
        const e = new Error("Render failed");
        e.status = 502; e.meta = st; throw e;
      }
    }
  }
  const e = new Error("Render timeout"); e.status = 504; throw e;
}

// -------- main handler
async function generateHandler(req,res){
  const request_id = crypto.randomBytes(5).toString("hex");
  try{
    if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }

    const tier = req.body?.tier === "quality" ? "quality" : "fast";
    const body = normalizeBody(req.body);
    // model must be exactly "veo3" or "veo3_fast"
    const model = tier === "quality" ? "veo3" : "veo3_fast";
    const payload = { model, ...body }; // KIE ignores duration; 8s fixed

    const sub = await enqueue(()=> postGenerate(payload));
    if(!(sub && sub.code === 200 && sub.data?.taskId)){
      const msg = sub?.msg || "No taskId from KIE";
      const e = new Error(msg); e.status = 502; e.meta = sub; throw e;
    }
    const taskId = sub.data.taskId;

    const done = await pollUntilDone(taskId);
    const video_url = Array.isArray(done.urls) && done.urls.length ? done.urls[0] : null;
    if(!video_url){ const e=new Error("No video_url in result"); e.status=502; e.meta=done; throw e; }

    res.json({ success:true, job_id: taskId, video_url, meta: done.raw, request_id });
  }catch(err){
    res.status(err.status||500).json({ success:false, error: String(err.message||err), request_id });
  }
}

// -------- routes (POST)
app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; generateHandler(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; generateHandler(req,res); });

// CORS preflight for Safari/iPad
for (const p of ["/generate-fast","/generate-quality"]) {
  app.options(p, (_req,res)=> res.set({
    "Access-Control-Allow-Origin": ORIG,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }).sendStatus(204));
}

app.listen(PORT, ()=> console.log(`🚀 KIE Veo3 backend LIVE on ${PORT} | CONCURRENCY=${MAX}`));
