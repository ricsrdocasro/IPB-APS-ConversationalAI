"""
AI Pipeline - Handles Deepgram STT, Deepseek LLM, and ElevenLabs TTS.
Implements fully streaming pipeline for low-latency conversational AI.
Uses official SDKs for each service (Deepgram v6, OpenAI, ElevenLabs).
"""

import asyncio
import json
import logging
import threading
import time
from typing import Callable, Optional
from queue import Queue
from openai import OpenAI
from elevenlabs.client import ElevenLabs
from deepgram import DeepgramClient
from deepgram.core.events import EventType

logger = logging.getLogger(__name__)


class AIPipeline:
    def __init__(self, deepgram_key: str, deepseek_key: str, elevenlabs_key: str):
        self.deepgram_key = (deepgram_key or "").strip()
        self.deepseek_key = (deepseek_key or "").strip()
        self.elevenlabs_key = (elevenlabs_key or "").strip()
        
        # Initialize clients
        self.deepseek_client = OpenAI(
            api_key=self.deepseek_key,
            base_url="https://api.siliconflow.com/v1"
        )
        self.elevenlabs_client = ElevenLabs(api_key=self.elevenlabs_key)
        self.deepgram_client = DeepgramClient(api_key=self.deepgram_key)
        
        self.is_listening = False
        self.text_buffer = ""
        self.audio_queue = Queue()
        self.tts_queue = asyncio.Queue()  # Sequential TTS queue
        self.listen_thread = None
        self.stop_listening_event = threading.Event()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.tts_worker_task = None
        
        # Callbacks
        self.on_transcript: Optional[Callable] = None
        self.on_ai_response: Optional[Callable] = None
        self.on_audio: Optional[Callable] = None
        self.on_error: Optional[Callable] = None
        self.interrupt_flag: Optional[asyncio.Event] = None
        
        self.system_prompt = """You are a helpful, friendly AI assistant engaged in real-time voice conversation. 
You MUST respond in the SAME LANGUAGE that the user is speaking. 
Keep responses concise and conversational."""

    async def test_connection(self):
        """Diagnose all API connections."""
        results = {
            "deepgram": {"status": "error", "message": "Not tested"},
            "deepseek": {"status": "error", "message": "Not tested"},
            "elevenlabs": {"status": "error", "message": "Not tested"},
            "overall": "unhealthy"
        }
        
        # Test Deepgram
        try:
            # We just try to create a client, or do a tiny check
            if self.deepgram_key:
                results["deepgram"] = {"status": "ok", "message": "Key provided"}
            else:
                results["deepgram"] = {"status": "error", "message": "Missing key"}
        except Exception as e:
            results["deepgram"] = {"status": "error", "message": str(e)}

        # Test Deepseek (SiliconFlow)
        try:
            self.deepseek_client.models.list()
            results["deepseek"] = {"status": "ok", "message": "Connected successfully"}
        except Exception as e:
            results["deepseek"] = {"status": "error", "message": str(e)}

        # Test ElevenLabs
        try:
            self.elevenlabs_client.voices.get_all()
            results["elevenlabs"] = {"status": "ok", "message": "Connected successfully"}
        except Exception as e:
            results["elevenlabs"] = {"status": "error", "message": str(e)}
            
        if all(r["status"] == "ok" for r in [results["deepgram"], results["deepseek"], results["elevenlabs"]]):
            results["overall"] = "healthy"
            
        return results

    async def start_listening(
        self,
        on_transcript: Callable,
        on_ai_response: Callable,
        on_audio: Callable,
        on_error: Callable,
        interrupt_flag: asyncio.Event
    ):
        """Start the STT pipeline."""
        self.loop = asyncio.get_running_loop()
        self.on_transcript = on_transcript
        self.on_ai_response = on_ai_response
        self.on_audio = on_audio
        self.on_error = on_error
        self.interrupt_flag = interrupt_flag
        self.is_listening = True
        self.text_buffer = ""
        self.stop_listening_event.clear()
        self.audio_queue = Queue()
        
        # Start TTS worker if not running
        if self.tts_worker_task is None or self.tts_worker_task.done():
            self.tts_worker_task = asyncio.create_task(self._tts_worker())
        
        self.listen_thread = threading.Thread(target=self._deepgram_listen_thread, daemon=True)
        self.listen_thread.start()

    async def _tts_worker(self):
        """Processes TTS requests sequentially."""
        while True:
            text = await self.tts_queue.get()
            try:
                if self.interrupt_flag and self.interrupt_flag.is_set():
                    self.tts_queue.task_done()
                    continue
                
                # Move original _send_to_tts logic here but rename it or call it
                await self._run_elevenlabs_tts(text)
            except Exception as e:
                logger.error(f"TTS Worker Error: {e}")
            finally:
                self.tts_queue.task_done()

    async def _run_elevenlabs_tts(self, text: str):
        if not text.strip() or not self.elevenlabs_key: return
        try:
            audio_gen = self.elevenlabs_client.text_to_speech.convert(
                text=text,
                voice_id="JBFqnCBsd6RMkjVDRZzb",
                model_id="eleven_multilingual_v2",
                output_format="pcm_16000"
            )
            for chunk in audio_gen:
                if self.interrupt_flag and self.interrupt_flag.is_set(): break
                if chunk and self.on_audio and self.loop:
                    self.loop.call_soon_threadsafe(self.on_audio, chunk)
        except Exception as e:
            logger.error(f"ElevenLabs TTS Error: {e}")
            if self.on_error and self.loop:
                self.loop.call_soon_threadsafe(self.on_error, f"TTS Error: {str(e)}")
        
    async def stop_listening(self, force_cutoff: bool = False):
        """Stop listening and process final transcript."""
        self.is_listening = False
        self.stop_listening_event.set()
        
        if self.listen_thread and self.listen_thread.is_alive():
            self.listen_thread.join(timeout=2.0)
            
        full_text = self.text_buffer.strip()
        if full_text:
            if self.on_transcript and self.loop:
                self.loop.call_soon_threadsafe(self.on_transcript, full_text)
            if self.loop:
                asyncio.run_coroutine_threadsafe(self._process_with_llm(full_text), self.loop)
        
        self.text_buffer = ""
    
    def _deepgram_listen_thread(self):
        """Run Deepgram connection in a thread."""
        import queue
        SILENCE_CHUNK = b'\x00' * 320
        last_send_time = time.time()
        
        try:
            with self.deepgram_client.listen.v1.connect(
                model="nova-2",
                language="pt",
                extra="detect_language=true",
                encoding="linear16",
                channels="1",
                sample_rate="16000",
                smart_format="true",
                interim_results="true",
            ) as connection:
                
                connection.on(EventType.MESSAGE, self._on_deepgram_message)
                listener_thread = threading.Thread(target=connection.start_listening, daemon=True)
                listener_thread.start()
                
                while not self.stop_listening_event.is_set():
                    try:
                        audio_chunk = self.audio_queue.get(timeout=0.1)
                        if audio_chunk is not None:
                            connection.send_media(audio_chunk)
                            last_send_time = time.time()
                    except queue.Empty:
                        if time.time() - last_send_time > 5.0:
                            try:
                                connection.send_media(SILENCE_CHUNK)
                                last_send_time = time.time()
                            except Exception: break
                        continue
                
                connection.send_finalize()
                time.sleep(0.2)
                connection.send_close_stream()
                
        except Exception as e:
            logger.error(f"Deepgram thread error: {e}")
            
    async def send_audio(self, audio_data: bytes):
        if self.is_listening:
            self.audio_queue.put_nowait(audio_data)

    def _on_deepgram_message(self, message):
        try:
            if self.interrupt_flag and self.interrupt_flag.is_set(): return
            
            if not hasattr(message, 'channel') or not message.channel: return
            alt = message.channel.alternatives[0]
            transcript = alt.transcript
            
            if transcript:
                is_final = getattr(message, 'is_final', False)
                if is_final:
                    self.text_buffer += " " + transcript
                    ui_text = self.text_buffer.strip()
                else:
                    ui_text = (self.text_buffer + " " + transcript).strip()
                
                if self.on_transcript and self.loop:
                    self.loop.call_soon_threadsafe(self.on_transcript, ui_text)
        except Exception: pass

    async def _process_with_llm(self, user_text: str):
        if not user_text.strip(): return
        try:
            # Clear existing TTS queue if starting new response
            while not self.tts_queue.empty():
                try: 
                    self.tts_queue.get_nowait()
                    self.tts_queue.task_done()
                except asyncio.QueueEmpty: break

            stream = self.deepseek_client.chat.completions.create(
                model="deepseek-ai/DeepSeek-V3.2-Exp",
                messages=[{"role": "system", "content": self.system_prompt}, {"role": "user", "content": user_text}],
                stream=True,
                temperature=0.7,
                max_tokens=512
            )
            
            phrase_buffer = ""
            for chunk in stream:
                if self.interrupt_flag and self.interrupt_flag.is_set(): break
                if chunk.choices and chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    if self.on_ai_response and self.loop:
                        self.loop.call_soon_threadsafe(self.on_ai_response, content)
                    
                    phrase_buffer += content
                    if any(p in content for p in {'.', '!', '?', '\n'}):
                        if phrase_buffer.strip():
                            await self.tts_queue.put(phrase_buffer.strip())
                            phrase_buffer = ""
            
            if phrase_buffer.strip() and not (self.interrupt_flag and self.interrupt_flag.is_set()):
                await self.tts_queue.put(phrase_buffer.strip())
            
            # Wait for all TTS to finish before signaling [END]
            await self.tts_queue.join()
            
            if self.on_ai_response and self.loop:
                self.loop.call_soon_threadsafe(self.on_ai_response, "\n[END]")
        except Exception as e:
            logger.error(f"LLM Error: {e}")
            if self.on_ai_response and self.loop:
                self.loop.call_soon_threadsafe(self.on_ai_response, "\n[END]")

    async def _send_to_tts(self, text: str):
        # This is now just a helper to put into the queue
        await self.tts_queue.put(text)
