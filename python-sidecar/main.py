import uvicorn
import asyncio
import logging
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body
from fastapi.middleware.cors import CORSMiddleware
from ai_pipeline import AIPipeline

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sidecar")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = None
interrupt_flag = asyncio.Event()

@app.post("/diagnose")
async def diagnose(payload: dict = Body(...)):
    global pipeline
    keys = payload.get("keys", {})
    temp_pipeline = AIPipeline(
        deepgram_key=keys.get("deepgram"),
        deepseek_key=keys.get("deepseek"),
        elevenlabs_key=keys.get("elevenlabs")
    )
    # Update global pipeline too so next run uses these keys
    pipeline = temp_pipeline
    return await temp_pipeline.test_connection()

@app.get("/microphones")
async def get_microphones():
    # Placeholder for actual device enumeration
    return {"microphones": ["Default System Microphone"], "default": 0}

@app.post("/test-mic")
async def test_mic():
    return {"status": "ok"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global pipeline
    await websocket.accept()
    loop = asyncio.get_running_loop()
    logger.info("Client connected via WebSocket")
    
    def send_transcript(text):
        asyncio.run_coroutine_threadsafe(
            websocket.send_json({"type": "transcript", "text": text}), loop
        )

    def send_ai_response(text):
        asyncio.run_coroutine_threadsafe(
            websocket.send_json({"type": "ai_response", "text": text}), loop
        )

    def send_audio(data):
        asyncio.run_coroutine_threadsafe(
            websocket.send_bytes(data), loop
        )

    def send_error(msg):
        asyncio.run_coroutine_threadsafe(
            websocket.send_json({"type": "error", "message": msg}), loop
        )

    try:
        while True:
            message = await websocket.receive()
            if "text" in message:
                data = json.loads(message["text"])
                action = data.get("action")
                
                if action == "configure":
                    keys = data.get("keys", {})
                    pipeline = AIPipeline(
                        deepgram_key=keys.get("deepgram"),
                        deepseek_key=keys.get("deepseek"),
                        elevenlabs_key=keys.get("elevenlabs")
                    )
                    await websocket.send_json({"type": "configured"})
                
                elif action == "start_listening":
                    if pipeline:
                        interrupt_flag.clear()
                        await pipeline.start_listening(
                            on_transcript=send_transcript,
                            on_ai_response=send_ai_response,
                            on_audio=send_audio,
                            on_error=send_error,
                            interrupt_flag=interrupt_flag
                        )
                
                elif action == "stop_listening":
                    if pipeline:
                        force_cutoff = data.get("forceCutoff", False)
                        await pipeline.stop_listening(force_cutoff=force_cutoff)
                
                elif action == "interrupt":
                    interrupt_flag.set()

            elif "bytes" in message:
                if pipeline and pipeline.is_listening:
                    await pipeline.send_audio(message["bytes"])

    except WebSocketDisconnect:
        if pipeline: await pipeline.stop_listening()
    except Exception as e:
        logger.error(f"WebSocket error: {e}")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
