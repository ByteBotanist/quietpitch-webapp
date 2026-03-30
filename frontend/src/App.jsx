import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import ClientDashboard from "./components/ClientDashboard";
import AdminAdvisorSettings from "./components/AdminAdvisorSettings";
import { Toaster } from "react-hot-toast";
import "./App.css";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

export default function App() {
  return (
    <ErrorBoundary>
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to="/demo" replace />} />
        <Route path="/admin/:slug" element={<AdminAdvisorSettings />} />
        <Route path="/:slug" element={<ClientDashboard />} />
      </Routes>

      {/* Toasts */}
      <Toaster position="top-right" 
      toastOptions={{ duration: 6000 }}
      />
    </Router>
  </ErrorBoundary>
  );
}



