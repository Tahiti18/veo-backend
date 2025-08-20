# Veo Backend Live (Fast + Quality)

This is a Railway-ready backend to run Google Veo 3 video generation (Fast + Quality) via fal.ai.

## Setup

1. Create `.env` in root:
   ```
   FAL_API_KEY=your_fal_ai_key_here
   PORT=8080
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Run locally:
   ```
   npm start
   ```

4. Deploy to Railway:
   - Push repo to GitHub
   - Link project in Railway
   - Add `FAL_API_KEY` in Railway → Variables
   - Done ✅

## Endpoints

- `POST /generate-fast` → returns video url (fast mode)
- `POST /generate-quality` → returns video url (quality mode)
- `GET /` → status check
