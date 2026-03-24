export default function Timer({ timeRemaining, maxTime, isActive }) {
  const percentage = (timeRemaining / maxTime) * 100
  const circumference = 2 * Math.PI * 45 // radius = 45
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  if (!isActive) return null

  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      {/* Background circle */}
      <svg className="absolute w-full h-full -rotate-90">
        <circle
          cx="48"
          cy="48"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          className="text-muted"
        />
        {/* Progress circle */}
        <circle
          cx="48"
          cy="48"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className={`transition-all duration-1000 ${
            timeRemaining <= 10 ? 'text-red-500' : 'text-primary'
          }`}
        />
      </svg>
      {/* Time text */}
      <span className={`text-lg font-semibold ${
        timeRemaining <= 10 ? 'text-red-500' : 'text-foreground'
      }`}>
        {timeRemaining}s
      </span>
    </div>
  )
}
