"""
Audio Buffer - Handles jitter control and audio playback.
Implements buffering strategy to ensure smooth audio output.
"""

import asyncio
import logging
from collections import deque
from typing import Optional
import threading

logger = logging.getLogger(__name__)

# Number of chunks to buffer before starting playback
INITIAL_BUFFER_SIZE = 3


class AudioBuffer:
    def __init__(self, sample_rate: int = 24000, channels: int = 1):
        self.sample_rate = sample_rate
        self.channels = channels
        self.buffer: deque = deque()
        self.is_playing = False
        self.playback_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._stream = None
        
    def add_chunk(self, audio_data: bytes):
        """Add an audio chunk to the buffer."""
        self.buffer.append(audio_data)
        
        # Start playback once we have enough buffered
        if len(self.buffer) >= INITIAL_BUFFER_SIZE and not self.is_playing:
            self._start_playback()
            
    def flush(self):
        """Clear the buffer and stop playback (for interruptions)."""
        self._stop_event.set()
        self.buffer.clear()
        self.is_playing = False
        
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
            
    def _start_playback(self):
        """Start audio playback in a separate thread."""
        self._stop_event.clear()
        self.is_playing = True
        self.playback_thread = threading.Thread(target=self._playback_loop)
        self.playback_thread.daemon = True
        self.playback_thread.start()
        
    def _playback_loop(self):
        """Main playback loop running in separate thread."""
        try:
            import sounddevice as sd
            
            self._stream = sd.OutputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype='int16'
            )
            self._stream.start()
            
            while not self._stop_event.is_set():
                if self.buffer:
                    chunk = self.buffer.popleft()
                    self._stream.write(chunk)
                else:
                    # Wait a bit for more data
                    self._stop_event.wait(timeout=0.01)
                    
            self._stream.stop()
            self._stream.close()
            
        except ImportError:
            logger.warning("sounddevice not installed, audio playback disabled")
        except Exception as e:
            logger.error(f"Audio playback error: {e}")
        finally:
            self.is_playing = False
            self._stream = None


class AsyncAudioBuffer:
    """Async version of AudioBuffer for use with asyncio."""
    
    def __init__(self, sample_rate: int = 24000, channels: int = 1):
        self.sample_rate = sample_rate
        self.channels = channels
        self.buffer: asyncio.Queue = asyncio.Queue()
        self.is_playing = False
        self._playback_task: Optional[asyncio.Task] = None
        self._stop_flag = False
        
    async def add_chunk(self, audio_data: bytes):
        """Add an audio chunk to the buffer."""
        await self.buffer.put(audio_data)
        
        # Start playback task if not running
        if not self.is_playing:
            self._stop_flag = False
            self._playback_task = asyncio.create_task(self._playback_loop())
            
    async def flush(self):
        """Clear the buffer and stop playback."""
        self._stop_flag = True
        
        # Clear the queue
        while not self.buffer.empty():
            try:
                self.buffer.get_nowait()
            except asyncio.QueueEmpty:
                break
                
        if self._playback_task:
            self._playback_task.cancel()
            try:
                await self._playback_task
            except asyncio.CancelledError:
                pass
                
        self.is_playing = False
        
    async def _playback_loop(self):
        """Async playback loop."""
        self.is_playing = True
        buffered_chunks = []
        
        try:
            # Buffer initial chunks
            for _ in range(INITIAL_BUFFER_SIZE):
                try:
                    chunk = await asyncio.wait_for(self.buffer.get(), timeout=1.0)
                    buffered_chunks.append(chunk)
                except asyncio.TimeoutError:
                    break
                    
            if not buffered_chunks:
                return
                
            # Play buffered chunks and continue with streaming
            try:
                import sounddevice as sd
                
                def callback(outdata, frames, time, status):
                    if buffered_chunks:
                        data = buffered_chunks.pop(0)
                        outdata[:len(data)] = data
                        if len(data) < len(outdata):
                            outdata[len(data):] = b'\x00' * (len(outdata) - len(data))
                    else:
                        outdata[:] = b'\x00' * len(outdata)
                
                with sd.OutputStream(
                    samplerate=self.sample_rate,
                    channels=self.channels,
                    dtype='int16',
                    callback=callback
                ):
                    while not self._stop_flag:
                        try:
                            chunk = await asyncio.wait_for(self.buffer.get(), timeout=0.1)
                            buffered_chunks.append(chunk)
                        except asyncio.TimeoutError:
                            if not buffered_chunks:
                                break
                                
            except ImportError:
                logger.warning("sounddevice not installed")
                
        except Exception as e:
            logger.error(f"Async playback error: {e}")
        finally:
            self.is_playing = False
