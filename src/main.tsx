import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JellyHero } from "./jelly/jelly-hero";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <JellyHero />
  </StrictMode>,
);
