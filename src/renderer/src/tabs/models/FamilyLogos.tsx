/** Bundled inline SVG marks for the Models grid columns — no remote fetches. */

export function GoogleLogo({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2.1 5.1-4.4 6.7v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.2z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.5 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.8 28.3c-.4-1.3-.7-2.8-.7-4.3s.2-2.9.7-4.3V14H4.5C3 17 2.1 20.4 2.1 24s.9 7 2.4 10l7.3-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 30 2 24 2 15.5 2 8.1 6.9 4.5 14l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z"
      />
    </svg>
  )
}

export function QwenLogo({ size = 13 }: { size?: number }) {
  // Stylized geometric Q mark in Qwen's purple range.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="qwen-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path
        fill="url(#qwen-grad)"
        d="M12 2.2 3.6 7v10L12 21.8 20.4 17V7L12 2.2zm0 2.3 6.4 3.7v7.6L12 19.5l-6.4-3.7V8.2L12 4.5z"
      />
      <path fill="url(#qwen-grad)" d="m13.6 13.2 4.2 4.2-1.7 1.7-4.2-4.2 1.7-1.7z" />
    </svg>
  )
}
