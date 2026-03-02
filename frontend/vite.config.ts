import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Option 1: Allow all hosts (Easiest for testing)
    allowedHosts: true, 

    // Option 2: Be specific (Safer)
    // allowedHosts: ['yetta-cerographical-benito.ngrok-free.dev'],
    
    host: true,
    port: 5173,
  }
})

