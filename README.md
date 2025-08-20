# Veo Backend (Live Integration)

This backend connects directly to **fal.ai Veo 3** (Fast & Quality).

## Endpoints
- `GET /` → Health check
- `POST /generate-fast` → Generates with `fal-ai/veo3/fast`
- `POST /generate-quality` → Generates with `fal-ai/veo3`

## Request Body Example
```json
{
  "prompt": "A cinematic drone shot flying over a futuristic neon city at night",
  "audio": false,
  "duration": 8,
  "aspect_ratio": "16:9"
}
```

## Setup
1. Create a GitHub repo, upload files.
2. Deploy on Railway.
3. Add Environment Variable: `FAL_KEY=your_fal_ai_api_key`
4. Expose service to internet.
5. Test with Postman or curl.
