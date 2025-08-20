import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Simple health check
app.get("/", (req, res) => {
  res.json({ status: "Veo 3 Fast backend running 🚀" });
});

// Endpoint to generate video
app.post("/generate-fast", async (req, res) => {
  const { prompt, audio } = req.body;

  try {
    const response = await axios.post(
      "https://fal.run/fal-ai/veo3/fast",
      {
        input: {
          prompt,
          audio_enabled: audio || false,
          duration: 8, // max for Veo 3 Fast
          aspect_ratio: "16:9"
        }
      },
      {
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      result: response.data
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});