// server.js — KIE Veo3 backend (correct paths + camelCase payload)
// ENV (Railway Variables):
//   KIE_KEY  (required)
//   KIE_API_PREFIX="https://api.kie.ai/api/v1" (optional)
//   CORS_ORIGIN="*"  PORT="8080"  CONCURRENCY="1" (optional)

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

// ---------- simple queue to avoid overlap ----------
let active = 0; const queue = [];
function enqueue(run){ return new Promise((resolve,reject)=>{ queue.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX || !queue.length) return; active++; const j=queue.shift(); try{ resolve(await j.run()); } catch(e){ j.reject(e); } finally{ active--; setImmediate(pump); }
  function resolve(v){ j.resolve(v); }}

// ---------- helpers ----------
const started = Date.now();
const ok = () => ({ ok:true, service:"kie-backend", time:new Date().toISOString() });
app.get("/", (_req,res)=> res.json(ok()));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix:API, kie_key_present:!!KEY }));
app.get("/stats",  (_req,res)=> res.json({ ok:true, uptime_sec:Math.floor((Date.now()-started)/1000), active, queued:queue.length, max_concurrency:MAX, api_prefix:API, key_present:!!KEY }));

function hdrs(){ return { Authorization:`Bearer ${KEY}`, "Content-Type":"application/json" }; }
async function kiePost(path, body){ const { data } = await axios.post(`${API}${path}`, body, { headers: hdrs(), timeout: 600_000 }); return data; }
async function kieGet(path, params){ const { data } = await axios.get(`${API}${path}`, { params, headers: hdrs(), timeout: 60_000 }); return data; }
const pickId = d => d?.data?.taskId || d?.taskId || d?.id || d?.data?.id || null;

// convert UI snake_case to KIE camelCase + mandatory model:"veo3"
const RATIOS = new Set(["16:9","9:16","1:1","4:3","3:4"]);
const RES    = new Set(["720p","1080p"]);
const clamp8 = s => Math.max(1, Math.min(8, Math.round(Number(s||8)*10)/10));
function toCamel(body={}){
  const { prompt, duration, aspect_ratio, with_audio, audio, resolution, style, negative_prompt, seed, call_back_url } = body;
  if(!prompt || !String(prompt).trim()){ const e=new Error("Prompt is required"); e.status=400; throw e; }
  const out = {
    model: "veo3",
    prompt: String(prompt),
    // KIE uses seconds via duration too, but camelCase for others:
    aspectRatio: RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "16:9",
    withAudio: (with_audio!==undefined ? with_audio : audio)!==false,
    duration: clamp8(duration)
  };
  if(RES.has(String(resolution))) out.resolution = String(resolution);
  if(style && String(style).trim()) out.style = String(style).trim();
  if(negative_prompt && String(negative_prompt).trim()) out.negativePrompt = String(negative_prompt).trim();
  if(seed !== undefined) out.seeds = seed;               // KIE key is "seeds"
  if(call_back_url) out.callBackUrl = String(call_back_url);
  return out;
}

// ---------- one handler for both tiers ----------
async function handleGenerate(req,res){
  const request_id = crypto.randomBytes(5).toString("hex");
  try{
    if(!KEY){ const e=new Error("Missing KIE_KEY"); e.status=500; throw e; }
    const tier = req.body?.tier==="quality" ? "quality" : "fast";
    const payload = toCamel(req.body);
    payload.mode = tier;                 // KIE accepts "mode": "fast" | "quality"

    // SUBMIT (correct endpoint)
    const sub = await enqueue(()=> kiePost("/veo/generate", payload));
    const taskId = pickId(sub);
    if(!taskId) return res.status(502).json({ success:false, error:"No job id from KIE", raw:sub, request_id });

    // POLL (correct endpoint)
    for(let i=0;i<120;i++){
      await new Promise(r=>setTimeout(r, 3000));
      const st = await enqueue(()=> kieGet("/veo/record-info", { id: taskId }));
      if(st?.status==="succeeded" && st?.output?.video_url){
        return res.json({ success:true, provider:"kie.veo3."+tier, job_id:taskId, video_url:st.output.video_url, meta:st, request_id });
      }
      if(st?.status==="failed"){ const e=new Error(st.error || "Render failed"); e.status=502; e.meta=st; throw e; }
    }
    const e=new Error("Render timeout"); e.status=504; throw e;
  }catch(err){
    res.status(err.status||500).json({ success:false, error:String(err.message||err), request_id });
  }
}

// Routes your frontend calls
app.post("/generate-fast",    (req,res)=>{ req.body = { ...req.body, tier:"fast"    }; handleGenerate(req,res); });
app.post("/generate-quality", (req,res)=>{ req.body = { ...req.body, tier:"quality" }; handleGenerate(req,res); });

// iPad/Safari preflight
app.options("/generate-fast",    (_req,res)=> res.set({"Access-Control-Allow-Origin":ORIG,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"}).sendStatus(204));
app.options("/generate-quality", (_req,res)=> res.set({"Access-Control-Allow-Origin":ORIG,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"}).sendStatus(204));

// quick browser triage (no console)
app.get("/triage", async (_req,res)=>{
  try{
    const sub = await kiePost("/veo/generate",{ model:"veo3", prompt:"triage probe", aspectRatio:"16:9", duration:1, withAudio:false, mode:"fast" });
    const id  = pickId(sub);
    let st=null;
    if(id){ try{ st = await kieGet("/veo/record-info",{ id }); }catch{} }
    res.json({ api:API, submit_ok: !!id, taskId:id||null, status_sample: st||null });
  }catch(e){
    res.json({ api:API, submit_ok:false, err: e?.response?.status || String(e) });
  }
});

app.listen(PORT, ()=> console.log(`🚀 KIE backend (LIVE) on ${PORT} | CONCURRENCY=${MAX}`));
