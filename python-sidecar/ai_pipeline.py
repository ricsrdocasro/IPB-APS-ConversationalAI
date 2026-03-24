"""
AI Pipeline - Handles Deepgram STT, Deepseek LLM, and ElevenLabs TTS.
Implements fully streaming pipeline for low-latency conversational AI.
Uses official SDKs for each service (Deepgram v6, OpenAI, ElevenLabs).
"""

import asyncio
import json
import logging
import threading
from typing import Callable, Optional
from queue import Queue
from openai import OpenAI
from elevenlabs.client import ElevenLabs
from deepgram import DeepgramClient
from deepgram.core.events import EventType

logger = logging.getLogger(__name__)


class AIPipeline:
    def __init__(self, deepgram_key: str, deepseek_key: str, elevenlabs_key: str):
        self.deepgram_key = deepgram_key
        self.deepseek_key = deepseek_key
        self.elevenlabs_key = elevenlabs_key
        
        # Initialize clients
        self.deepseek_client = OpenAI(
            api_key=deepseek_key,
            base_url="https://api.siliconflow.com/v1"
        )
        self.elevenlabs_client = ElevenLabs(api_key=elevenlabs_key)
        self.deepgram_client = DeepgramClient(api_key=deepgram_key)
        
        self.deepgram_connection = None
        self.is_listening = False
        self.text_buffer = ""
        self.audio_queue = Queue()  # Queue for audio data to send to Deepgram
        self.listen_thread = None
        self.stop_listening_event = threading.Event()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        
        # Callbacks
        self.on_transcript: Optional[Callable] = None
        self.on_ai_response: Optional[Callable] = None
        self.on_audio: Optional[Callable] = None
        self.interrupt_flag: Optional[asyncio.Event] = None
        
        # System prompt for multilingual support
        self.system_prompt = """You are a helpful, friendly AI assistant engaged in real-time voice conversation. 
You MUST respond in the SAME LANGUAGE that the user is speaking. 
Keep responses concise and conversational. 
If the user's audio is cut off, politely acknowledge it in their language."""
        
        self.cutoff_injection = "[System Note: The user's audio was automatically cut off due to time limits. Politely acknowledge that you had to interrupt them in their language, address what they managed to say, and ask them to continue.]"

    async def start_listening(
        self,
        on_transcript: Callable,
        on_ai_response: Callable,
        on_audio: Callable,
        interrupt_flag: asyncio.Event
    ):
        """Start the STT pipeline."""
        self.loop = asyncio.get_running_loop()
        self.on_transcript = on_transcript
        self.on_ai_response = on_ai_response
        self.on_audio = on_audio
        self.interrupt_flag = interrupt_flag
        self.is_listening = True
        self.text_buffer = ""
        self.stop_listening_event.clear()
        self.audio_queue = Queue()
        
        # Start Deepgram listening in a separate thread
        self.listen_thread = threading.Thread(target=self._deepgram_listen_thread, daemon=True)
        self.listen_thread.start()
        logger.info("Deepgram listen thread started")
        
    async def stop_listening(self, force_cutoff: bool = False):
        """Stop listening and process final transcript."""
        self.is_listening = False
        self.stop_listening_event.set()
        
        # Wait for thread to finish
        if self.listen_thread and self.listen_thread.is_alive():
            self.listen_thread.join(timeout=5.0)
        
        # If force cutoff, inject system note
        if force_cutoff and self.text_buffer:
            self.text_buffer += f" {self.cutoff_injection}"
            
        full_text = self.text_buffer.strip()
        if full_text:
            # Send final confirmed transcript to UI one last time
            if self.on_transcript and self.loop:
                self.loop.call_soon_threadsafe(self.on_transcript, full_text)
                
            logger.info(f"Final accumulated transcript: {full_text}")
            if self.loop:
                asyncio.run_coroutine_threadsafe(self._process_with_llm(full_text), self.loop)
        
        self.text_buffer = ""
    
    def _deepgram_listen_thread(self):
        """Run Deepgram connection in a thread using SDK v6 patterns."""
        import queue
        import time
        from deepgram.core.events import EventType
        
        SILENCE_CHUNK = b'\x00' * 320
        last_send_time = time.time()
        
        try:
            logger.info("Connecting to Deepgram...")
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
                
                connection.on(EventType.OPEN, lambda _: logger.info("Deepgram connection opened"))
                connection.on(EventType.MESSAGE, self._on_deepgram_message)
                connection.on(EventType.CLOSE, lambda _: logger.info("Deepgram connection closed"))
                connection.on(EventType.ERROR, lambda error: logger.error(f"Deepgram error: {error}"))
                
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
                    except Exception as e:
                        if "1011" not in str(e):
                            logger.error(f"Error sending audio to Deepgram: {e}")
                        break
                
                try:
                    connection.send_finalize()
                    time.sleep(0.2)
                    connection.send_close_stream()
                except Exception: pass
                
        except Exception as e:
            logger.error(f"Deepgram listen thread error: {e}")
            
    async def send_audio(self, audio_data: bytes):
        """Queue audio chunk to be sent to Deepgram."""
        if self.is_listening:
            try:
                self.audio_queue.put_nowait(audio_data)
            except Exception as e:
                logger.error(f"Error queuing audio: {e}")

    def _on_deepgram_message(self, message):
        """Handle messages from Deepgram v6 SDK."""
        try:
            if self.interrupt_flag and self.interrupt_flag.is_set():
                return
            
            msg_type = getattr(message, "type", "Unknown")
            if msg_type != "Results" or not hasattr(message, 'channel') or not message.channel:
                return

            channel = message.channel
            if not hasattr(channel, 'alternatives') or not channel.alternatives:
                return
            
            alt = channel.alternatives[0]
            transcript = alt.transcript
            
            if transcript:
                is_final = getattr(message, 'is_final', False)
                speech_final = getattr(message, 'speech_final', False)
                
                if is_final or speech_final:
                    self.text_buffer += " " + transcript
                    ui_text = self.text_buffer.strip()
                else:
                    ui_text = (self.text_buffer + " " + transcript).strip()
                
                if self.on_transcript and self.loop:
                    self.loop.call_soon_threadsafe(self.on_transcript, ui_text)
                        
        except Exception as e:
            logger.error(f"Error processing Deepgram message: {e}")

    async def _process_with_llm(self, user_text: str):
        """Send text to DeepSeek LLM and stream response in strictly sequential sentence chunks."""
        if not user_text.strip(): return
        if self.interrupt_flag and self.interrupt_flag.is_set(): return
            
        try:
            logger.info(f"Processing with LLM: {user_text}")
            stream = self.deepseek_client.chat.completions.create(
                model="deepseek-ai/DeepSeek-V3.2-Exp",
                messages=[
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": user_text}
                ],
                stream=True,
                temperature=0.7,
                max_tokens=512
            )
            
            phrase_buffer = ""
            
            for chunk in stream:
                if self.interrupt_flag and self.interrupt_flag.is_set(): break
                    
                if chunk.choices and chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    phrase_buffer += content
                    
                    # Detect natural sentence breaks
                    words = phrase_buffer.split()
                    should_flush = False
                    
                    if any(p in content for p in {'.', '!', '?', '\n'}):
                        should_flush = True
                    elif any(p in content for p in {',', ';', ':'}) and len(words) >= 10:
                        should_flush = True
                    elif len(words) >= 20 and (content.endswith(' ') or content.endswith('\t')):
                        should_flush = True
                        
                    if should_flush and phrase_buffer.strip():
                        # AWAIT ensuring sentences are processed in order
                        await self._send_to_tts(phrase_buffer)
                        phrase_buffer = ""
            
            if phrase_buffer.strip() and not (self.interrupt_flag and self.interrupt_flag.is_set()):
                await self._send_to_tts(phrase_buffer)
            
            if self.on_ai_response and self.loop:
                self.loop.call_soon_threadsafe(self.on_ai_response, "\n[END]")
                    
        except Exception as e:
            logger.error(f"Error processing with LLM: {e}")

    async def _send_to_tts(self, text: str):
        """Send text to ElevenLabs TTS and forward text+audio to frontend in sync."""
        if not text.strip(): return
            
        try:
            # Send text to UI as soon as we start processing the audio for it
            if self.on_ai_response and self.loop:
                self.loop.call_soon_threadsafe(self.on_ai_response, text)

            # ElevenLabs SDK returns a generator for the audio bytes
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
            
            # Small pause between sentences for natural prosody and sync
            await asyncio.sleep(0.1)
            
        except Exception as e:
            logger.error(f"Error sending to TTS: {e}")
