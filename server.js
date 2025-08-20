import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "🚀 Veo 3 Live Backend Running with ESM" });
});

// Fast generation endpoint
app.post("/generate-fast", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    // Example call to fal.ai or another API (replace with live API)
    const response = await axios.post("https://api.fal.ai/generate-fast", { prompt });

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("Fast Gen Error:", err.message);
    res.status(500).json({ error: "Generation failed" });
  }
});

// Quality generation endpoint
app.post("/generate-quality", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const response = await axios.post("https://api.fal.ai/generate-quality", { prompt });

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("Quality Gen Error:", err.message);
    res.status(500).json({ error: "Generation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Veo backend live on port ${PORT}`);
});