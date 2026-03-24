import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/tauri'

export default function Settings({ isOpen, onClose }) {
  const [keys, setKeys] = useState({
    deepgram: '',
    deepseek: '',
    elevenlabs: ''
  })
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [microphones, setMicrophones] = useState([])
  const [selectedMic, setSelectedMic] = useState('')
  const [isTesting, setIsTesting] = useState(false)

  useEffect(() => {
    if (isOpen) {
      loadKeys()
      loadMicrophones()
    }
  }, [isOpen])

  const loadMicrophones = async () => {
    try {
      // Get list of microphones from the backend
      const response = await fetch('http://localhost:8765/microphones')
      if (response.ok) {
        const data = await response.json()
        setMicrophones(data.microphones || [])
        if (data.default !== undefined) {
          setSelectedMic(data.default.toString())
        }
      }
    } catch (error) {
      console.error('Failed to load microphones:', error)
    }
  }

  const loadKeys = async () => {
    try {
      const savedKeys = await invoke('get_api_keys')
      if (savedKeys) {
        setKeys(savedKeys)
      }
    } catch (error) {
      console.error('Failed to load API keys:', error)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    setMessage('')
    try {
      await invoke('save_api_keys', { keys })
      setMessage('API keys saved securely!')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      setMessage('Failed to save API keys')
      console.error('Failed to save API keys:', error)
    }
    setIsSaving(false)
  }

  const handleChange = (key, value) => {
    setKeys(prev => ({ ...prev, [key]: value }))
  }

  const testMicrophone = async () => {
    setIsTesting(true)
    setMessage('')
    try {
      const response = await fetch('http://localhost:8765/test-mic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: parseInt(selectedMic) })
      })
      
      if (response.ok) {
        setMessage('Microphone test successful! 🎤')
        setTimeout(() => setMessage(''), 3000)
      } else {
        setMessage('Microphone test failed')
      }
    } catch (error) {
      setMessage('Error testing microphone')
      console.error('Test failed:', error)
    }
    setIsTesting(false)
  }

  const testAPI = async () => {
    setMessage('')
    try {
      const response = await fetch('http://localhost:8765/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys })
      })
      
      if (response.ok) {
        const result = await response.json()
        let diagnostic = `API Diagnostic:\n`
        diagnostic += `Deepgram: ${result.deepgram.status} - ${result.deepgram.message}\n`
        diagnostic += `Deepseek: ${result.deepseek.status} - ${result.deepseek.message}\n`
        diagnostic += `ElevenLabs: ${result.elevenlabs.status} - ${result.elevenlabs.message}\n`
        diagnostic += `Overall: ${result.overall}`
        
        setMessage(diagnostic)
      } else {
        setMessage('Diagnostic failed')
      }
    } catch (error) {
      setMessage('Error connecting to API')
      console.error('API test failed:', error)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-lg p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Microphone
            </label>
            <div className="flex gap-2">
              <select
                value={selectedMic}
                onChange={(e) => setSelectedMic(e.target.value)}
                className="flex-1 px-3 py-2 bg-muted border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Select a microphone...</option>
                {microphones.map((mic, index) => (
                  <option key={index} value={index.toString()}>
                    {mic}
                  </option>
                ))}
              </select>
              <button
                onClick={testMicrophone}
                disabled={isTesting || !selectedMic}
                className="px-3 py-2 bg-secondary text-foreground rounded-md hover:bg-secondary/80 disabled:opacity-50 transition-colors text-sm"
              >
                {isTesting ? 'Testing...' : 'Test'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Deepgram API Key
            </label>
            <input
              type="password"
              value={keys.deepgram}
              onChange={(e) => handleChange('deepgram', e.target.value)}
              placeholder="Enter your Deepgram API key"
              className="w-full px-3 py-2 bg-muted border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Deepseek API Key
            </label>
            <input
              type="password"
              value={keys.deepseek}
              onChange={(e) => handleChange('deepseek', e.target.value)}
              placeholder="Enter your Deepseek API key"
              className="w-full px-3 py-2 bg-muted border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              ElevenLabs API Key
            </label>
            <input
              type="password"
              value={keys.elevenlabs}
              onChange={(e) => handleChange('elevenlabs', e.target.value)}
              placeholder="Enter your ElevenLabs API key"
              className="w-full px-3 py-2 bg-muted border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {message && (
            <p className={`text-sm whitespace-pre-wrap ${message.includes('error') || message.includes('Error') ? 'text-destructive' : 'text-green-500'}`}>
              {message}
            </p>
          )}

          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isSaving ? 'Saving...' : 'Save API Keys'}
          </button>

          <button
            onClick={testAPI}
            className="w-full py-2 bg-secondary text-foreground rounded-md hover:bg-secondary/80 transition-colors text-sm"
          >
            Test API Connection
          </button>
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          Your API keys are encrypted and stored securely on your device.
        </p>
      </div>
    </div>
  )
}
