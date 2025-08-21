// server.js — KIE backend full
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const ORIG = process.env.CORS_ORIGIN || "*";
const API  = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY  = process.env.KIE_KEY;
const MAX  = Math.max(1, Number(process.env.CONCURRENCY || 1));

app.use(cors({ origin: ORIG }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req,res)=> res.json({ ok:true, service:"kie-backend", time:new Date().toISOString() }));
app.get("/health", (_req,res)=> res.json({ ok:true, api_prefix: API, kie_key_present: !!KEY }));

let active=0; const q=[];
function enqueue(run){ return new Promise((resolve,reject)=>{ q.push({run,resolve,reject}); pump(); }); }
async function pump(){ if(active>=MAX||q.length===0)return; active++; const {run,resolve,reject}=q.shift();
  try{resolve(await run());}catch(e){reject(e);}finally{active--; setImmediate(pump);} }

function pickTaskId(sub){ return sub?.data?.taskId || sub?.taskId || sub?.id || sub?.job_id || null; }

async function kiePost(path,payload){
  if(!KEY) throw new Error("Missing KIE_KEY");
  const url=`${API}${path}`;
  const {data}=await axios.post(url,payload,{headers:{Authorization:`Bearer ${KEY}`,"Content-Type":"application/json"},timeout:600000});
  return data;
}
async function kieGet(path,params){ const url=`${API}${path}`;
  const {data}=await axios.get(url,{params,headers:{Authorization:`Bearer ${KEY}`},timeout:60000});
  return data;
}
async function pollTask(statusPath,taskId){
  for(let i=0;i<120;i++){ await new Promise(r=>setTimeout(r,3000));
    const st=await kieGet(statusPath,{taskId});
    if(st?.status==="succeeded"&&st?.output?.video_url) return st;
    if(st?.status==="failed"){throw new Error(st.error||"Render failed");} }
  throw new Error("Render timeout");
}

function endpoints(tier="fast"){
  return { submit:"/veo3/generate", status:"/veo3/record-info", payload:{mode:tier==="quality"?"quality":"fast"}, tag:`kie.veo3.${tier}` };
}

async function handleGenerate(req,res){
  const reqId=crypto.randomBytes(5).toString("hex");
  try{
    const {tier="fast"}=req.body||{}; const ep=endpoints(tier); const body=req.body;
    const submit=await enqueue(()=>kiePost(ep.submit,body));
    const taskId=pickTaskId(submit);
    if(!taskId) return res.status(502).json({success:false,error:"No job id from KIE",raw_submit:submit,request_id:reqId});
    const done=await enqueue(()=>pollTask(ep.status,taskId));
    return res.json({success:true,provider:ep.tag,job_id:taskId,video_url:done.output.video_url,meta:done,request_id:reqId});
  }catch(err){ res.status(500).json({success:false,error:err.message,request_id:reqId}); }
}

app.post("/generate-fast",(req,res)=>{req.body={...req.body,tier:"fast"};handleGenerate(req,res);});
app.post("/generate-quality",(req,res)=>{req.body={...req.body,tier:"quality"};handleGenerate(req,res);});

app.listen(PORT,()=>console.log(`🚀 KIE backend LIVE on ${PORT}`));
