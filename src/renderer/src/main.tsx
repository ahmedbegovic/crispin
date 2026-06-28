import React from 'react'
import { createRoot } from 'react-dom/client'
// Inter (variable, weight 100–900) — bundled woff2, no network. Body font set in index.css.
// Explicit .css subpath so the ambient `*.css` module type applies (TS2882 otherwise).
import '@fontsource-variable/inter/index.css'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
