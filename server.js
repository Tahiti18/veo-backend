const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const KIE_KEY = process.env.KIE_KEY;
const KIE_API_PREFIX = process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1";

// health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    api_prefix: KIE_API_PREFIX,
    kie_key_present: !!KIE_KEY,
  });
});

// helper to call KIE API
async function callKie(endpoint, body) {
  const resp = await fetch(`${KIE_API_PREFIX}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KIE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`KIE error ${resp.status}: ${txt}`);
  }
  return resp.json();
}

// fast route
app.post("/generate-fast", async (req, res) => {
  try {
    const data = await callKie("generate-fast", req.body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// quality route
app.post("/generate-quality", async (req, res) => {
  try {
    const data = await callKie("generate-quality", req.body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
