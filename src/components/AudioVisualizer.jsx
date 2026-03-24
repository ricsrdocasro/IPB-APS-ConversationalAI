import { useEffect, useState, useRef } from 'react'

export default function AudioVisualizer({ isListening, analyser }) {
  const [levels, setLevels] = useState(Array(24).fill(0))
  const animationRef = useRef()

  useEffect(() => {
    if (!isListening || !analyser) {
      setLevels(Array(24).fill(0))
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      return
    }

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    const update = () => {
      analyser.getByteFrequencyData(dataArray)
      
      // We want to map the frequency data to our 24 bars
      // We'll focus on the lower frequencies where most speech resides
      const newLevels = []
      const step = Math.floor(bufferLength / 3 / 24) // Focus on first 1/3 of frequencies
      
      for (let i = 0; i < 24; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) {
          sum += dataArray[i * step + j]
        }
        const avg = sum / step
        // Scale and smooth
        newLevels.push(Math.min(100, (avg / 255) * 150))
      }

      setLevels(newLevels)
      animationRef.current = requestAnimationFrame(update)
    }

    update()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [isListening, analyser])

  return (
    <div className="flex items-center gap-[3px] h-12 justify-center">
      {levels.map((level, i) => (
        <div
          key={i}
          className="w-1.5 rounded-full bg-primary transition-all duration-75"
          style={{
            height: `${Math.max(4, level)}%`,
            opacity: 0.3 + (level / 100) * 0.7
          }}
        />
      ))}
    </div>
  )
}
