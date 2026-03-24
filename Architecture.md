# Conversational AI Pipeline: Architecture Document

## 1. System Overview
This application is a native Windows executable (`.exe`) designed to facilitate a real-time, low-latency conversational AI. It utilizes a modern web frontend housed within a compiled Rust shell, communicating with a bundled Python backend that manages streaming API connections.

### Tech Stack
* **App Shell & Bundler:** Tauri (Rust)
* **Frontend UI:** React + Tailwind CSS (Shadcn UI design system)
* **Backend Logic:** Python (Tauri Sidecar)
* **Local Bridge:** WebSockets / FastAPI (Frontend <-> Backend communication)
    * **Data Format:** JSON-encoded objects. Audio is transported as arrays of PCM 16-bit integers.

---

## 2. Project Folder Structure
This is the recommended structural layout to separate the Rust, React, and Python environments.

    my-ai-app/
    ├── src/                  # React Frontend (Shadcn, UI components)
    │   ├── components/       # UI Elements (Settings, Timer, Mic Button)
    │   └── App.jsx           # Main React logic
    ├── src-tauri/            # Tauri Backend (Rust & Build configs)
    │   ├── tauri.conf.json   # Tauri configuration (registers the Python sidecar)
    │   └── src/              # Rust source code
    └── python-sidecar/       # Python Backend 
        ├── main.py           # FastAPI/WebSocket server
        ├── audio_buffer.py   # Jitter control and playback logic (legacy/optional)
        └── ai_pipeline.py    # Deepgram, Deepseek (Silicon Flow), ElevenLabs logic

---

## 3. The Core AI Pipeline (Fully Streaming)
To achieve sub-700ms latency, the pipeline operates on a continuous stream. No step waits for the previous step to fully complete.

### Audio Technical Specifications
* **Sample Rate:** 16,000 Hz (16kHz)
* **Bit Depth:** PCM 16-bit (Signed)
* **Channels:** 1 (Mono)
* **Transport:** WebSocket JSON arrays (Int16)

### Pipeline Stages
1. **The Ear (Deepgram STT):**
   * Raw microphone audio is captured in React (`AudioContext`) and streamed to Python.
   * Python maintains a persistent connection to Deepgram via the v6 SDK.
   * Deepgram returns real-time transcripts; final results trigger the next stage.

2. **The Brain (Deepseek LLM):**
   * Python sends final transcripts to **Deepseek (via Silicon Flow)** using the OpenAI-compatible SDK.
   * The request uses `stream=True` to return text tokens immediately via SSE.

3. **The Voice (ElevenLabs TTS):**
   * Text tokens are buffered by punctuation and piped into the **ElevenLabs SDK**.
   * ElevenLabs returns audio bytes via HTTP streaming.
   * Python converts these bytes to Int16 samples and sends them back to the **React Frontend** for playback.

---

## 4. Custom Middleware & Logic Optimizations
These processes ensure the AI feels human, responsive, and emotionally intelligent.

### A. The Punctuation Buffer
* **Problem:** Streaming single words to ElevenLabs results in flat, robotic intonation.
* **Solution:** Deepseek text tokens are caught in a Python buffer. They are only flushed to ElevenLabs when a punctuation mark (`.`, `,`, `?`, `!`, `;`, `:`) is detected, providing context for emotional delivery.

### B. Frontend Audio Queue (Jitter Management)
* **Problem:** Network latency fluctuations can cause stuttering if audio chunks are played immediately.
* **Solution:** The **React Frontend** manages an audio playback sequence. It reconstructs Float32 data from the received Int16 samples and plays them via the `AudioContext` destination.

### C. Endpointing (Silence Detection)
* **Problem:** The system needs to know exactly when the user has finished speaking.
* **Solution:** Deepgram's Voice Activity Detection (VAD) is utilized. The backend identifies "final" results to trigger the LLM stage.

### D. Barge-in (Interruption Logic)
* **Problem:** The user needs to be able to interrupt the AI mid-sentence.
* **Solution:** If user audio is detected or the "Interrupt" button is pressed, a global `interrupt` event is set in Python. This immediately terminates the Deepseek stream and the ElevenLabs generation, preventing unwanted audio from being sent.

---

## 5. Guardrails & Overflow Prevention
These protections ensure the app doesn't crash, burn unnecessary credits, or encounter token limits.

### A. The "Rambler" Guardrail (Token Overflow Prevention)
To prevent latency spikes and context window overflows if a user speaks continuously:
* **Frontend Timer:** A 30-second hidden countdown begins in React when the mic activates.
* **Force Cut-off:** If the timer hits zero, React forces an artificial "stop listening" command.

### B. Graceful Interruption (Prompt Injection)
To ensure the AI doesn't respond awkwardly to a forced cut-off:
* **System Prompt:** Python intercepts the incomplete text and appends: `[System Note: The user's audio was automatically cut off due to time limits. Politely acknowledge that you had to interrupt them, address what they managed to say, and ask them to continue.]`

---

## 6. Security & API Key Management
* **Vulnerability:** Hardcoding keys in a compiled `.exe` is a massive security risk.
* **Implementation:** Keys are **never** hardcoded. The UI includes a "Settings" modal for the user to input their Deepgram, Deepseek, and ElevenLabs keys. Tauri securely stores these on the local OS and passes them to the Python sidecar at runtime.
