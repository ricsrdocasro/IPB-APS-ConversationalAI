import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import MicButton from './components/MicButton'
import Timer from './components/Timer'
import Settings from './components/Settings'
import AudioVisualizer from './components/AudioVisualizer'

const MAX_RECORDING_TIME = 30 

function App() {
  // Session Management
  const [sessions, setSessions] = useState(() => {
    const saved = localStorage.getItem('ipb_ai_sessions')
    return saved ? JSON.parse(saved) : [{ id: 'default', title: 'First Conversation', messages: [] }]
  })
  const [currentSessionId, setCurrentSessionId] = useState('default')
  
  // Current Turn State
  const [isListening, setIsListening] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  
  // UI State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(MAX_RECORDING_TIME)
  const [isConnected, setIsConnected] = useState(false)
  const [analyser, setAnalyser] = useState(null)
  
  const wsRef = useRef(null)
  const timerRef = useRef(null)
  const audioContextRef = useRef(null)
  const processorRef = useRef(null)
  const playbackContextRef = useRef(null)
  const nextStartTimeRef = useRef(0)
  const messagesEndRef = useRef(null)
  
  const transcriptRef = useRef('')
  const aiResponseRef = useRef('')

  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { aiResponseRef.current = aiResponse }, [aiResponse])

  useEffect(() => {
    localStorage.setItem('ipb_ai_sessions', JSON.stringify(sessions))
  }, [sessions])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [sessions, transcript, aiResponse, isThinking, scrollToBottom])

  const activeSession = sessions.find(s => s.id === currentSessionId) || sessions[0]

  const createNewSession = () => {
    const newId = Date.now().toString()
    const newSession = { id: newId, title: `Chat ${sessions.length + 1}`, messages: [] }
    setSessions(prev => [newSession, ...prev])
    setCurrentSessionId(newId)
    setTranscript('')
    setAiResponse('')
  }

  const deleteSession = (e, id) => {
    e.stopPropagation()
    if (sessions.length === 1) return
    setSessions(prev => prev.filter(s => s.id !== id))
    if (currentSessionId === id) setCurrentSessionId(sessions.find(s => s.id !== id).id)
  }

  const playAudio = useCallback(async (arrayBuffer) => {
    if (!playbackContextRef.current) {
      playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
    }
    const context = playbackContextRef.current
    if (context.state === 'suspended') await context.resume()
    
    const int16Array = new Int16Array(arrayBuffer)
    const float32Data = new Float32Array(int16Array.length)
    for (let i = 0; i < int16Array.length; i++) {
      float32Data[i] = int16Array[i] / 32768.0
    }
    
    const buffer = context.createBuffer(1, float32Data.length, 16000)
    buffer.getChannelData(0).set(float32Data)
    const startTime = Math.max(context.currentTime, nextStartTimeRef.current)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start(startTime)
    nextStartTimeRef.current = startTime + buffer.duration
  }, [])

  const connectToBackend = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    wsRef.current = new WebSocket('ws://localhost:8765/ws')
    wsRef.current.binaryType = 'arraybuffer'
    wsRef.current.onopen = () => setIsConnected(true)
    wsRef.current.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudio(event.data)
        return
      }
      const data = JSON.parse(event.data)
      if (data.type === 'transcript') {
        setTranscript(data.text)
      } else if (data.type === 'ai_response') {
        setIsThinking(false)
        if (data.text === '\n[END]') {
          // Commit to history with summary title update if first message
          setSessions(prev => prev.map(s => {
            if (s.id === currentSessionId) {
              const newMessages = [
                ...s.messages,
                { role: 'user', content: transcriptRef.current },
                { role: 'assistant', content: aiResponseRef.current }
              ]
              // Update title if it's the first message
              let newTitle = s.title
              if (s.messages.length === 0 && transcriptRef.current) {
                newTitle = transcriptRef.current.slice(0, 30) + (transcriptRef.current.length > 30 ? '...' : '')
              }
              return { ...s, messages: newMessages, title: newTitle }
            }
            return s
          }))
          setTranscript('')
          setAiResponse('')
          return
        }
        setAiResponse(prev => prev + data.text)
      } else if (data.type === 'error') {
        console.error('Backend Error:', data.message);
        alert(data.message);
      }
      };
    wsRef.current.onclose = () => {
      setIsConnected(false)
      setTimeout(connectToBackend, 2000)
    }
  }, [playAudio, currentSessionId])

  useEffect(() => {
    connectToBackend()
    return () => wsRef.current?.close()
  }, [connectToBackend])

  useEffect(() => {
    if (isListening) {
      timerRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) { stopListening(true); return MAX_RECORDING_TIME }
          return prev - 1
        })
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      setTimeRemaining(MAX_RECORDING_TIME)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isListening])

  const startListening = async () => {
    if (!isConnected) return
    setIsListening(true)
    setIsThinking(false)
    setTranscript('')
    setAiResponse('')
    
    const keys = await invoke('get_api_keys')
    wsRef.current?.send(JSON.stringify({ action: 'configure', keys }))
    wsRef.current?.send(JSON.stringify({ action: 'start_listening' }))
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      const analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 256
      setAnalyser(analyserNode)
      source.connect(analyserNode)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor
      processor.onaudioprocess = (e) => {
        const audioData = e.inputBuffer.getChannelData(0)
        const int16Data = new Int16Array(audioData.length)
        for (let i = 0; i < audioData.length; i++) {
          const s = Math.max(-1, Math.min(1, audioData[i]))
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }
        wsRef.current?.send(int16Data.buffer)
      }
      source.connect(processor)
      processor.connect(audioContext.destination)
    } catch (e) { setIsListening(false) }
  }

  const stopListening = (forceCutoff = false) => {
    setIsListening(false)
    setIsThinking(true)
    if (processorRef.current) processorRef.current.disconnect()
    if (audioContextRef.current) audioContextRef.current.close()
    setAnalyser(null)
    wsRef.current?.send(JSON.stringify({ action: 'stop_listening', forceCutoff }))
  }

  const handleMicClick = () => {
    if (isListening) stopListening(false)
    else startListening()
  }

  const handleInterrupt = () => {
    wsRef.current?.send(JSON.stringify({ action: 'interrupt' }))
    setAiResponse('')
    setIsThinking(false)
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden font-sans antialiased text-foreground dark">
      {/* Sidebar */}
      <div className="w-80 border-r bg-card flex flex-col p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
            <img src="/ipb_logo_small.png" alt="IPB" className="w-7 h-7 object-contain invert" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">IPB AI</h1>
            <p className="text-xs text-muted-foreground">Conversational Pipeline</p>
          </div>
        </div>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">System</p>
            <div className="bg-secondary/50 rounded-xl p-3 border border-border/50 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className={isConnected ? 'text-green-500 font-medium' : 'text-red-500'}>
                  {isConnected ? '● Online' : '● Offline'}
                </span>
              </div>
              <Timer timeRemaining={timeRemaining} maxTime={MAX_RECORDING_TIME} isActive={isListening} />
            </div>
          </div>

          <div className="space-y-2 flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">Chat Sessions</p>
              <button onClick={createNewSession} className="text-[10px] font-bold text-primary hover:underline hover:text-primary/80 transition-all">+ NEW CHAT</button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 pr-2 custom-scrollbar">
              {sessions.map(s => (
                <div key={s.id} className="group relative">
                  <button
                    onClick={() => {
                      setCurrentSessionId(s.id)
                      setTranscript('')
                      setAiResponse('')
                      setIsThinking(false)
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-xs truncate transition-all ${
                      currentSessionId === s.id 
                        ? 'bg-primary/15 text-primary font-semibold border border-primary/30 ring-1 ring-primary/20' 
                        : 'text-muted-foreground hover:bg-secondary border border-transparent'
                    }`}
                  >
                    {s.title}
                  </button>
                  {sessions.length > 1 && (
                    <button 
                      onClick={(e) => deleteSession(e, s.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:text-destructive text-muted-foreground"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pt-4 border-t space-y-4">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="w-full flex items-center justify-between px-4 py-2 rounded-xl hover:bg-secondary transition-all text-xs font-medium text-muted-foreground border border-transparent hover:border-border"
          >
            <span className="flex items-center gap-2">⚙️ Settings</span>
            <span>→</span>
          </button>
          <div className="flex items-center justify-center py-2 grayscale hover:grayscale-0 transition-all cursor-help" title="Instituto Politécnico de Bragança">
            <img src="/ipb_logo.png" alt="IPB Logo" className="w-24 h-12 object-contain invert opacity-60" />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative bg-secondary/20">
        <div className="flex-1 overflow-y-auto p-8 scroll-smooth">
          <div className="w-full max-w-3xl mx-auto space-y-8 pb-12">
            {activeSession.messages.map((msg, idx) => (
              <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className="mb-2">
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${msg.role === 'user' ? 'text-muted-foreground mr-2' : 'text-primary ml-2'}`}>
                    {msg.role === 'user' ? 'You' : 'Assistant'}
                  </span>
                </div>
                <div className={`max-w-[85%] p-5 rounded-2xl shadow-sm ${
                  msg.role === 'user' ? 'bg-card border rounded-tr-none' : 'bg-primary/5 border border-primary/20 rounded-tl-none'
                }`}>
                  <p className="text-base leading-relaxed text-foreground/90 whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}

            {(isListening || transcript) && (
              <div className="flex flex-col items-end animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="mb-2"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-2">You</span></div>
                <div className="bg-card border rounded-2xl rounded-tr-none p-5 shadow-sm max-w-[85%] border-primary/20">
                  <p className="text-base leading-relaxed text-foreground/90">{transcript || 'Listening...'}</p>
                </div>
              </div>
            )}

            {(isThinking || aiResponse) && (
              <div className="flex flex-col items-start animate-in fade-in slide-in-from-left-4 duration-300">
                <div className="mb-2"><span className="text-[10px] font-bold uppercase tracking-widest text-primary ml-2">Assistant</span></div>
                <div className="bg-primary/5 border border-primary/20 rounded-2xl rounded-tl-none p-5 shadow-sm relative group max-w-[85%]">
                  <div className="text-base leading-relaxed text-foreground/90 whitespace-pre-wrap">
                    {aiResponse || (isThinking && <div className="flex gap-1 py-2"><div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]" /><div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]" /><div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" /></div>)}
                  </div>
                  {aiResponse && !isListening && (
                    <button onClick={handleInterrupt} className="absolute -bottom-10 left-0 text-[10px] font-bold uppercase tracking-widest text-destructive hover:opacity-80 py-2 font-semibold">
                      × Stop Response
                    </button>
                  )}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="h-32 border-t bg-card/80 backdrop-blur-xl flex flex-col items-center justify-center px-8 relative">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-border to-transparent" />
          <div className="w-full max-w-lg space-y-4">
            {isListening && <div className="h-6"><AudioVisualizer isListening={isListening} analyser={analyser} /></div>}
            <div className="flex items-center justify-center">
              <MicButton isListening={isListening} onClick={handleMicClick} disabled={!isConnected} />
            </div>
          </div>
        </div>
      </main>

      <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  )
}

export default App
