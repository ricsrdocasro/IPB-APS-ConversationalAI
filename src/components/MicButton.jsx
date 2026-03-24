export default function MicButton({ isListening, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        relative w-20 h-20 rounded-full transition-all duration-300
        flex items-center justify-center
        ${disabled 
          ? 'bg-muted cursor-not-allowed opacity-50' 
          : isListening 
            ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/50' 
            : 'bg-primary hover:bg-primary/90 shadow-lg'
        }
      `}
    >
      {/* Mic Icon */}
      <svg 
        xmlns="http://www.w3.org/2000/svg" 
        width="32" 
        height="32" 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke="currentColor" 
        strokeWidth="2" 
        strokeLinecap="round" 
        strokeLinejoin="round"
        className={`${disabled ? 'text-muted-foreground' : 'text-primary-foreground'}`}
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" x2="12" y1="19" y2="22"/>
      </svg>

      {/* Pulsing animation when listening */}
      {isListening && (
        <>
          <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-25" />
          <span className="absolute inset-0 rounded-full bg-red-500 animate-pulse opacity-25" />
        </>
      )}
    </button>
  )
}
