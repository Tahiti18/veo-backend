// server.js — KIE-only backend (taskId-safe, fast boot, dual-auth, veo→veo3 fallback)
// ENV: KIE_KEY (required)
//      KIE_API_PREFIX? (default https://api.kie.ai/api/v1)
//      CORS_ORIGIN? (default *)
//      PORT? (default 8080)
//      CONCURRENCY? (default 1)

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
const MAX   = Math.max(1, Number(process.env.CONCURRENCY || 1)); // simple & safe

app.use(cors({ origin: ORIG }));
app.use(express.json({ limit: "1mb" }));

// ---------- health
app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));

// ---------- tiny queue (prevents overlapping calls)
let active = 0; const q = [];
function enqueue(run){ return new Promise((resolve,reject)=>{ q.push({run,resolve,reject}); pump(); }); }
async function pump(){
  if(active >= MAX || q.length===0) return;
  active++;
  const {run,resolve,reject} = q.shift();
  try{ resolve(await run()); }catch(e){ reject(e); }finally{ active--; setImmediate(pump); }
}

// ---------- payload guard
const RATIOS = new Set(["16:9","9:16","1:1","4:3","3:4"]);
const RES    = new Set(["720p","1080p"]);
const clamp  = s => Math.max(1, Math.min(8, Math.round(Number(s||8)*10)/10));

function sanitize(b={}){
  const { prompt, duration, aspect_ratio, with_audio, resolution, style, negative_prompt, seed } = b;
  if(!prompt || !String(prompt).trim()){ const e=new Error("Prompt is required"); e.status=400; throw e; }
  const out = {
    prompt: String(prompt),
    duration: clamp(duration),
    aspect_ratio: RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "9:16",
    with_audio: with_audio === false ? false : true
  };
  if(resolution && RES.has(String(resolution))) out.resolution = String(resolution);
  if(style && String(style).trim()) out.style = String(style).trim();
  if(negative_prompt && String(negative_prompt).trim()) out.negative_prompt = String(negative_prompt).trim();
  if(seed !== undefined) out.seed = seed;
  return out;
}

// ---------- KIE helpers (dual-auth, taskId aware)
async function kiePost(path, payload){
  if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
  const url = `${API}${path}`;
  // send BOTH auth styles (some tenants require x-api-key)
  const headers = {
    Authorization: `Bearer ${KEY}`,
    "x-api-key": KEY,
    "Content-Type":"application/json"
  };
  const { data } = await axios.post(url, payload, { headers, timeout: 600_000 });
  return data;
}
async function kieGet(path, params){
  const url = `${API}${path}`;
  const headers = { Authorization: `Bearer ${KEY}`, "x-api-key": KEY };
  const { data } = await axios.get(url, { params, headers, timeout: 60_000 });
  return data;
}
function pickTaskId(sub){
  return (
    sub?.data?.taskId ||
    sub?.taskId ||
    sub?.data?.id ||
    sub?.id ||
    sub?.job_id ||
    sub?.result?.taskId ||
    null
  );
}
async function pollTask(statusPath, taskId){
  const tryOnce = async (path) => kieGet(path, { taskId });
  for(let i=0;i<120;i++){
    await new Promise(r=>setTimeout(r, 3000));
    let st = await tryOnce(statusPath);
    if (!st?.status && /\/veo\//.test(statusPath)) {
      // fallback to /veo3/ status if legacy path returned an odd shape
      st = await tryOnce(statusPath.replace("/veo/", "/veo3/"));
    }
    if(st?.status === "succeeded" && st?.output?.video_url) return st;
    if(st?.status === "failed"){ const e=new Error(st.error || "Render failed"); e.status=502; e.meta=st; throw e; }
  }
  const e=new Error("Render timeout"); e.status=504; throw e;
}

// ---------- endpoints (veo with auto-fallback to veo3)
function endpoints(tier="fast"){
  return {
    submit: "/veo3/generate",
    status: "/veo3/record-info",
    payload: { mode: tier==="quality" ? "quality" : "fast" },
    tag: `kie.veo3.${tier}`
  };
}

// ---------- single handler with veo→veo3 fallback
async function handleGenerate(req,res){
  const reqId = crypto.randomBytes(5).toString("hex");
  try{
    const { tier="fast", callback_url } = req.body || {};
    const ep = endpoints(tier);
    const body = sanitize(req.body);

    // 1) Try legacy /veo/*
    let submit = await enqueue(() => kiePost(ep.submit, { ...ep.payload, ...body, ...(callback_url ? { callback_url } : {}) }));
    let taskId = pickTaskId(submit);

    // 2) If no taskId, retry with /veo3/*
    if(!taskId){
      const submitV3 = ep.submit.replace("/veo/", "/veo3/");
      submit = await enqueue(() => kiePost(submitV3, { ...ep.payload, ...body, ...(callback_url ? { callback_url } : {}) }));
      taskId = pickTaskId(submit);
    }

    if(!taskId){
      return res.status(502).json({
        success:false,
        error:"No job id from KIE",
        tried: { primary: ep.submit, fallback: ep.submit.replace("/veo/", "/veo3/") },
        raw_submit: submit,
        request_id: reqId
      });
    }

    if(callback_url){
      return res.json({ success:true, enqueued:true, job_id:taskId, tier, request_id:reqId });
    }

    const statusPath = ep.status; // poll will auto-fallback to /veo3/ if needed
    const done = await enqueue(() => pollTask(statusPath, taskId));
    return res.json({ success:true, provider:ep.tag, job_id:taskId, video_url:done.output.video_url, meta:done, request_id:reqId });
  }catch(err){
    console.error(`[GEN ${reqId}]`, err.status||"", err.message);
    res.status(err.status||500).json({ success:false, error: err.message, request_id:reqId });
  }
}

// ---------- routes
app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; handleGenerate(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; handleGenerate(req,res); });

// ---------- debug (no credits)
app.post("/debug/sanitize", (req,res)=>{
  try{ res.json({ ok:true, payload: sanitize(req.body) }); }
  catch(e){ res.status(e.status||400).json({ ok:false, error:e.message }); }
});

app.listen(PORT, ()=> console.log(`🚀 KIE backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
