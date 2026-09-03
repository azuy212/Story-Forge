import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/hooks/use-theme";
import { SheetProvider } from "@/hooks/use-sheet";
import { App } from "./App";
import "@/styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <ThemeProvider>
    <SheetProvider>
      <App />
    </SheetProvider>
  </ThemeProvider>,
);
