import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import "./index.css";

const isAdmin = window.location.pathname.replace(/\/$/, "") === "/admin123";

createRoot(document.getElementById("root")).render(
  <StrictMode>{isAdmin ? <Admin /> : <App />}</StrictMode>
);
