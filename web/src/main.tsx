import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const element = document.getElementById("root");
if (!element) throw new Error("missing #root");
createRoot(element).render(<App />);
