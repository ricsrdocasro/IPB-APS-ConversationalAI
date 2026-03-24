import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/tauri'
import { open } from '@tauri-apps/api/shell'
import MicButton from './components/MicButton'
import Timer from './components/Timer'
import Settings from './components/Settings'
import AudioVisualizer from './components/AudioVisualizer'

const MAX_RECORDING_TIME = 30 
const INITIAL_SESSION_ID = 1 

function App() {
  // Session Management
  const [sessions, setSessions] = useState([{ id: INITIAL_SESSION_ID, title: 'Initial Session', messages: [] }])
  const [activeSessionId, setActiveSessionId] = useState(INITIAL_SESSION_ID)
  
  const [isListening, setIsListening] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
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
  
  const currentTranscriptRef = useRef('')
  const currentAiResponseRef = useRef('')

  const activeSession = useMemo(() => 
    sessions.find(s => s.id === activeSessionId) || sessions[0], 
  [sessions, activeSessionId])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [activeSession?.messages, transcript, aiResponse, isThinking, scrollToBottom])

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

  const stopListening = useCallback((forceCutoff = false) => {
    setIsListening(false)
    setIsThinking(true)
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    setAnalyser(null)
    wsRef.current?.send(JSON.stringify({ action: 'stop_listening', forceCutoff }))
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
        currentTranscriptRef.current = data.text
      } else if (data.type === 'ai_response') {
        setIsThinking(false) 
        if (data.text === '\n[END]') {
          const userMsg = currentTranscriptRef.current
          const assistantMsg = currentAiResponseRef.current
          
          if (userMsg || assistantMsg) {
            setSessions(prev => prev.map(s => {
              if (s.id === activeSessionId) {
                return {
                  ...s,
                  title: s.messages.length === 0 ? (userMsg.slice(0, 30) + (userMsg.length > 30 ? '...' : '')) : s.title,
                  messages: [...s.messages, { role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg }]
                }
              }
              return s
            }))
          }
          setTranscript('')
          setAiResponse('')
          currentTranscriptRef.current = ''
          currentAiResponseRef.current = ''
          return
        }
        setAiResponse(prev => {
          const updated = prev + data.text
          currentAiResponseRef.current = updated
          return updated
        })
      }
    }
    
    wsRef.current.onclose = () => {
      setIsConnected(false)
      setTimeout(connectToBackend, 2000)
    }
  }, [playAudio, activeSessionId])

  useEffect(() => {
    connectToBackend()
    return () => { if (wsRef.current) wsRef.current.close() }
  }, [connectToBackend])

  useEffect(() => {
    if (isListening) {
      timerRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            stopListening(true)
            return MAX_RECORDING_TIME
          }
          return prev - 1
        })
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      setTimeRemaining(MAX_RECORDING_TIME)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isListening, stopListening])

  const createNewSession = () => {
    const newId = Date.now()
    const newSession = { id: newId, title: 'New Session', messages: [] }
    setSessions(prev => [newSession, ...prev])
    setActiveSessionId(newId)
  }

  const startListening = async () => {
    if (!isConnected) return
    setIsListening(true)
    setIsThinking(false)
    setTranscript('')
    setAiResponse('')
    currentTranscriptRef.current = ''
    currentAiResponseRef.current = ''
    
    const keys = await invoke('get_api_keys')
    wsRef.current?.send(JSON.stringify({ action: 'configure', keys }))
    wsRef.current?.send(JSON.stringify({ action: 'start_listening' }))
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, echoCancellation: true } })
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
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(int16Data.buffer)
        }
      }
      source.connect(processor)
      processor.connect(audioContext.destination)
    } catch (e) { 
      setIsListening(false) 
    }
  }

  const handleMicClick = () => {
    if (isListening) stopListening(false)
    else startListening()
  }

  const handleInterrupt = () => {
    wsRef.current?.send(JSON.stringify({ action: 'interrupt' }))
    setAiResponse('')
    currentAiResponseRef.current = ''
    setIsThinking(false)
  }

  const handleExternalLink = useCallback(async (url) => {
    try {
      await open(url)
    } catch (err) {
      console.error('Failed to open external link:', err)
    }
  }, [])

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
            <p className="text-xs text-muted-foreground">Conversational AI</p>
          </div>
        </div>

        <button 
          onClick={createNewSession}
          className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-all shadow-lg shadow-primary/20"
        >
          + New Session
        </button>

        <div className="flex-1 overflow-y-auto space-y-1 pr-2 scrollbar-hide">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 mb-2 px-2">History</p>
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-all border ${
                activeSessionId === s.id 
                  ? 'bg-secondary border-border font-medium shadow-sm' 
                  : 'border-transparent hover:bg-secondary/50 text-muted-foreground'
              }`}
            >
              <div className="truncate w-full">{s.title}</div>
              <div className="text-[10px] opacity-50 mt-0.5">{s.messages.length / 2} interactions</div>
            </button>
          ))}
        </div>

        <div className="space-y-4 pt-4 border-t">
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">System</p>
            <div className="bg-secondary/30 rounded-xl p-3 border border-border/50 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">Status</span>
                <span className={`flex items-center gap-1.5 font-medium text-xs ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
                   {isConnected ? 'Connected' : 'Offline'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">Timer</span>
                <span className="font-mono text-[10px] text-muted-foreground/80">{timeRemaining}s remaining</span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <button onClick={() => setIsSettingsOpen(true)} className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl hover:bg-secondary transition-all text-xs font-medium text-muted-foreground border border-transparent hover:border-border">
              <span className="flex items-center gap-2">⚙️ Settings</span>
              <span>→</span>
            </button>
            
            <button 
              onClick={() => handleExternalLink('https://github.com/ricsrdocasro/IPB-APS-ConversationalAI')}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl hover:bg-secondary transition-all text-xs font-medium text-muted-foreground border border-transparent hover:border-border"
            >
              <span className="flex items-center gap-2">📦 Source Code</span>
              <span>→</span>
            </button>
          </div>

          <div className="flex items-center justify-center py-2 opacity-60 hover:opacity-100 transition-opacity">
            <button onClick={() => handleExternalLink('https://ipb.pt/pt')}>
              <img src="/ipb_logo.png" alt="IPB Logo" className="w-32 h-16 object-contain invert cursor-pointer" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative bg-secondary/10">
        <div className="flex-1 overflow-y-auto p-8 scroll-smooth">
          <div className="w-full max-w-3xl mx-auto space-y-8 pb-12">
            {activeSession?.messages.map((msg, idx) => (
              <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                <div className="mb-2">
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${msg.role === 'user' ? 'text-muted-foreground mr-2' : 'text-primary ml-2'}`}>
                    {msg.role === 'user' ? 'You' : 'Assistant'}
                  </span>
                </div>
                <div className={`max-w-[85%] p-6 rounded-2xl shadow-sm ${
                  msg.role === 'user' ? 'bg-card border rounded-tr-none' : 'bg-primary/5 border border-primary/20 rounded-tl-none'
                }`}>
                  <p className="text-lg leading-relaxed text-foreground/90 whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}

            {(isListening || transcript) && (
              <div className="flex flex-col items-end">
                <div className="mb-2"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-2">You</span></div>
                <div className="bg-card border rounded-2xl rounded-tr-none p-6 shadow-sm max-w-[85%]">
                  <p className="text-lg leading-relaxed text-foreground/90">{transcript || (isListening ? 'Listening...' : '')}</p>
                </div>
              </div>
            )}

            {(isThinking || aiResponse) && (
              <div className="flex flex-col items-start animate-in fade-in slide-in-from-bottom-4">
                <div className="mb-2"><span className="text-[10px] font-bold uppercase tracking-widest text-primary ml-2">Assistant</span></div>
                <div className="bg-primary/5 border border-primary/20 rounded-2xl rounded-tl-none p-6 shadow-sm mr-12 relative max-w-[85%]">
                  <div className="text-lg leading-relaxed text-foreground/90 whitespace-pre-wrap">
                    {aiResponse || <div className="flex gap-1.5 py-2"><div className="w-2 h-2 bg-primary rounded-full animate-bounce" /><div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" /><div className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.4s]" /></div>}
                  </div>
                  {aiResponse && !isListening && (
                    <button onClick={handleInterrupt} className="absolute -bottom-10 left-0 text-[10px] font-bold uppercase text-destructive hover:opacity-80 py-2">
                      × Interrupt
                    </button>
                  )}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="h-44 border-t bg-card/50 backdrop-blur-xl flex flex-col items-center justify-center px-8 relative">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-border to-transparent" />
          <div className="w-full max-w-lg space-y-6">
            {isListening && <div className="h-8"><AudioVisualizer isListening={isListening} analyser={analyser} /></div>}
            <div className="flex items-center justify-center">
              <MicButton isListening={isListening} onClick={handleMicClick} disabled={isConnected === false} />
            </div>
          </div>
        </div>
      </main>

      <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  )
}

export default App
