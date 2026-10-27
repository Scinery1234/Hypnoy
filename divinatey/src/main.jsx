import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { routePath } from "./preview.js";
import "./styles.css";

// The Career Reading pages (/career…) have their own look and load separately.
const CareerApp = lazy(() => import("./career/CareerApp.jsx"));
const career = /^career(\/|$)/.test(routePath());

createRoot(document.getElementById("root")).render(
  <StrictMode>{career ? <Suspense fallback={null}><CareerApp /></Suspense> : <App />}</StrictMode>
);
