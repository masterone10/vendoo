import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Handle and suppress benign development HMR websocket closures in iframe/embedded preview
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reasonMsg = event.reason?.message || String(event.reason || '');
    if (
      reasonMsg.includes('WebSocket closed without opened') ||
      reasonMsg.includes('failed to connect to websocket') ||
      reasonMsg.includes('The operation was aborted')
    ) {
      event.preventDefault();
      // Silently prevent unhandled rejection noise for development HMR transport
    }
  });
}

createRoot(document.getElementById('root')!).render(<App />);
