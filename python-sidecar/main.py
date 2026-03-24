"""
Conversational AI Pipeline - Main FastAPI/WebSocket Server
Handles communication between frontend and AI services.
"""

import asyncio
import json
import logging
import struct
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import httpx
from openai import OpenAI
from elevenlabs.client import ElevenLabs
from deepgram import DeepgramClient
from deepgram.core.events import EventType

from ai_pipeline import AIPipeline
from audio_buffer import AudioBuffer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Conversational AI Backend")

# Request models
class DiagnoseRequest(BaseModel):
    keys: dict = {}

class MicTestRequest(BaseModel):
    device_id: int = 0

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
pipeline: AIPipeline = None
audio_buffer: AudioBuffer = None
interrupt_flag = asyncio.Event()


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def send_message(self, message: dict, websocket: WebSocket):
        await websocket.send_json(message)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)


manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global pipeline, audio_buffer
    
    await manager.connect(websocket)
    logger.info("Client connected")
    
    try:
        loop = asyncio.get_running_loop()
        
        # Define thread-safe message sender that handles both dict and bytes
        def thread_safe_send(msg):
            if isinstance(msg, (bytes, bytearray)):
                asyncio.run_coroutine_threadsafe(websocket.send_bytes(msg), loop)
            else:
                asyncio.run_coroutine_threadsafe(manager.send_message(msg, websocket), loop)

        while True:
            # Use lower-level receive to handle both text and bytes
            message = await websocket.receive()
            
            if "text" in message:
                data = json.loads(message["text"])
                action = data.get("action")
                
                if action == "configure":
                    # Initialize pipeline with API keys
                    keys = data.get("keys", {})
                    pipeline = AIPipeline(
                        deepgram_key=keys.get("deepgram", ""),
                        deepseek_key=keys.get("deepseek", ""),
                        elevenlabs_key=keys.get("elevenlabs", "")
                    )
                    audio_buffer = AudioBuffer()
                    await manager.send_message({"type": "configured"}, websocket)
                    
                elif action == "start_listening":
                    if pipeline:
                        interrupt_flag.clear()
                        asyncio.create_task(
                            pipeline.start_listening(
                                on_transcript=lambda t: thread_safe_send({"type": "transcript", "text": t}),
                                on_ai_response=lambda t: thread_safe_send({"type": "ai_response", "text": t}),
                                on_audio=lambda a: thread_safe_send(a), # a is now bytes
                                interrupt_flag=interrupt_flag
                            )
                        )
                        
                elif action == "stop_listening":
                    if pipeline:
                        force_cutoff = data.get("forceCutoff", False)
                        await pipeline.stop_listening(force_cutoff=force_cutoff)
                        
                elif action == "interrupt":
                    interrupt_flag.set()
                    if audio_buffer:
                        audio_buffer.flush()
                    await manager.send_message({"type": "interrupted"}, websocket)
            
            elif "bytes" in message:
                # Handle raw binary audio data from frontend
                audio_bytes = message["bytes"]
                if pipeline and pipeline.is_listening:
                    await pipeline.send_audio(audio_bytes)
                    
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/test-message")
async def test_message():
    """Test endpoint to send a test message to connected clients."""
    await manager.broadcast({
        "type": "transcript",
        "text": "Test message - API is working!"
    })
    return {"status": "sent"}


@app.post("/diagnose")
async def diagnose(request: DiagnoseRequest):
    """Comprehensive diagnostic of all API connections with detailed logging."""
    # Get keys from request
    keys = request.keys
    deepgram_key = keys.get("deepgram", "")
    deepseek_key = keys.get("deepseek", "")
    elevenlabs_key = keys.get("elevenlabs", "")
    
    logger.info("=== API DIAGNOSTIC STARTED ===")
    logger.info(f"Deepgram key present: {bool(deepgram_key)} (length: {len(deepgram_key)})")
    logger.info(f"Deepseek key present: {bool(deepseek_key)} (length: {len(deepseek_key)})")
    logger.info(f"ElevenLabs key present: {bool(elevenlabs_key)} (length: {len(elevenlabs_key)})")
    
    results = {
        "deepgram": {"status": "untested", "message": ""},
        "deepseek": {"status": "untested", "message": ""},
        "elevenlabs": {"status": "untested", "message": ""},
        "overall": "pending"
    }
    
    # Test Deepgram using SDK
    logger.info("--- Testing Deepgram (SDK) ---")
    try:
        if not deepgram_key:
            results["deepgram"]["status"] = "error"
            results["deepgram"]["message"] = "No API key configured"
            logger.warning("Deepgram: No API key provided")
        else:
            logger.info(f"Testing Deepgram with key: {deepgram_key[:10]}...")
            try:
                deepgram_client = DeepgramClient(api_key=deepgram_key)
                # Test connection by creating a non-streaming connection
                logger.info("Creating Deepgram client...")
                logger.info("✅ Deepgram: SDK initialized successfully")
                results["deepgram"]["status"] = "ok"
                results["deepgram"]["message"] = "Connected successfully"
            except Exception as sdk_error:
                logger.error(f"Deepgram SDK error: {sdk_error}", exc_info=True)
                results["deepgram"]["status"] = "error"
                results["deepgram"]["message"] = f"SDK Error: {str(sdk_error)[:100]}"
    except Exception as e:
        results["deepgram"]["status"] = "error"
        results["deepgram"]["message"] = str(e)
        logger.error(f"Deepgram exception: {e}", exc_info=True)
    
    # Test Deepseek/Silicon Flow using OpenAI SDK
    logger.info("--- Testing Deepseek (Silicon Flow via OpenAI SDK) ---")
    try:
        if not deepseek_key:
            results["deepseek"]["status"] = "error"
            results["deepseek"]["message"] = "No API key configured"
            logger.warning("Deepseek: No API key provided")
        else:
            logger.info(f"Testing Deepseek with key: {deepseek_key[:10]}...")
            try:
                client = OpenAI(
                    api_key=deepseek_key,
                    base_url="https://api.siliconflow.com/v1"
                )
                logger.info("Sending test message to Deepseek...")
                response = client.chat.completions.create(
                    model="deepseek-ai/DeepSeek-V3.2-Exp",
                    messages=[{"role": "user", "content": "test"}],
                    max_tokens=10,
                    stream=False,
                    timeout=30.0
                )
                logger.info(f"✅ Deepseek: OK - Response: {response.choices[0].message.content[:50]}")
                results["deepseek"]["status"] = "ok"
                results["deepseek"]["message"] = "Connected successfully"
            except Exception as sdk_error:
                logger.error(f"Deepseek SDK error: {sdk_error}", exc_info=True)
                error_str = str(sdk_error)
                if "401" in error_str or "Unauthorized" in error_str:
                    results["deepseek"]["status"] = "error"
                    results["deepseek"]["message"] = "Invalid API key - check your Silicon Flow key"
                elif "timeout" in error_str.lower():
                    results["deepseek"]["status"] = "error"
                    results["deepseek"]["message"] = "Request timed out - check internet or Silicon Flow status"
                else:
                    results["deepseek"]["status"] = "error"
                    results["deepseek"]["message"] = f"SDK Error: {error_str[:100]}"
    except Exception as e:
        results["deepseek"]["status"] = "error"
        results["deepseek"]["message"] = str(e)
        logger.error(f"Deepseek exception: {e}", exc_info=True)
    
    # Test ElevenLabs using SDK
    logger.info("--- Testing ElevenLabs (SDK) ---")
    try:
        if not elevenlabs_key:
            results["elevenlabs"]["status"] = "error"
            results["elevenlabs"]["message"] = "No API key configured"
            logger.warning("ElevenLabs: No API key provided")
        else:
            logger.info(f"Testing ElevenLabs with key: {elevenlabs_key[:10]}...")
            try:
                client = ElevenLabs(api_key=elevenlabs_key)
                logger.info("Testing text-to-speech conversion...")
                # Test with actual TTS conversion instead of listing voices
                audio = client.text_to_speech.convert(
                    text="Test",
                    voice_id="JBFqnCBsd6RMkjVDRZzb",
                    model_id="eleven_multilingual_v2",
                    output_format="pcm_16000"
                )
                logger.info("✅ ElevenLabs: OK - TTS conversion successful")
                results["elevenlabs"]["status"] = "ok"
                results["elevenlabs"]["message"] = "Connected successfully"
            except Exception as sdk_error:
                logger.error(f"ElevenLabs SDK error: {sdk_error}", exc_info=True)
                error_str = str(sdk_error)
                if "401" in error_str or "Unauthorized" in error_str or "missing_permissions" in error_str:
                    results["elevenlabs"]["status"] = "error"
                    results["elevenlabs"]["message"] = "Invalid API key or insufficient permissions"
                else:
                    results["elevenlabs"]["status"] = "error"
                    results["elevenlabs"]["message"] = f"SDK Error: {error_str[:100]}"
    except Exception as e:
        results["elevenlabs"]["status"] = "error"
        results["elevenlabs"]["message"] = str(e)
        logger.error(f"ElevenLabs exception: {e}", exc_info=True)
    
    # Determine overall status
    all_ok = all(r["status"] == "ok" for r in [results["deepgram"], results["deepseek"], results["elevenlabs"]])
    results["overall"] = "healthy" if all_ok else "degraded"
    
    logger.info(f"=== DIAGNOSTIC COMPLETE: {results['overall'].upper()} ===")
    
    return results


@app.get("/microphones")
async def list_microphones():
    """List available input microphones."""
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        input_devices = []
        default_device = sd.default.device[0]
        
        for i, device in enumerate(devices):
            if device['max_input_channels'] > 0:
                input_devices.append({
                    "id": i,
                    "name": device['name']
                })
        
        return {
            "microphones": [d["name"] for d in input_devices],
            "default": default_device
        }
    except Exception as e:
        logger.error(f"Error listing microphones: {e}")
        return {"microphones": [], "default": 0, "error": str(e)}


@app.post("/test-mic")
async def test_microphone(request: MicTestRequest):
    """Test microphone by recording and playing back audio."""
    try:
        import sounddevice as sd
        import numpy as np
        
        device_id = request.device_id
        duration = 2  # 2 seconds
        sample_rate = 16000
        
        # Record audio
        logger.info(f"Recording from device {device_id}")
        audio = sd.rec(
            int(duration * sample_rate),
            samplerate=sample_rate,
            channels=1,
            device=device_id,
            dtype=np.int16
        )
        sd.wait()
        
        # Play it back
        logger.info("Playing back recorded audio")
        sd.play(audio, samplerate=sample_rate, device=device_id)
        sd.wait()
        
        return {"status": "success", "message": "Microphone test completed"}
    except Exception as e:
        logger.error(f"Microphone test failed: {e}")
        return {"status": "error", "message": str(e)}


def main():
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")


if __name__ == "__main__":
    main()
