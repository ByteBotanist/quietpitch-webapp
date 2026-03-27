import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

window.addEventListener("error", (e) => {
  console.group("🧨 window.error");
  console.error(e.message);
  console.error(e.error);
  console.groupEnd();
});

window.addEventListener("unhandledrejection", (e) => {
  console.group("🧨 unhandledrejection");
  console.error(e.reason);
  console.groupEnd();
});
