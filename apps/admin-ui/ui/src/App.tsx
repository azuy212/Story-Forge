import React, { useEffect, useState } from "react";
import { Home } from "./pages/Home";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Launch } from "./pages/Launch";
import { Auth } from "./pages/Auth";
import { ImageProvider } from "./pages/ImageProvider";
import { Tts } from "./pages/Tts";
import { Transcriber } from "./pages/Transcriber";

type Route = { name: string; ns?: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return { name: "home" };
  const [name, ...rest] = h.split("/");
  return { name, ns: rest.join("/") };
}

const NAV = [
  { name: "home", label: "Home" },
  { name: "runs", label: "Runs" },
  { name: "launch", label: "Launch" },
  { name: "image", label: "Image Provider" },
  { name: "tts", label: "TTS" },
  { name: "transcriber", label: "Transcriber" },
  { name: "auth", label: "YouTube Auth" },
];

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(name: string, ns?: string) {
    window.location.hash = ns ? `/${name}/${ns}` : `/${name}`;
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-ink-900 border-r border-zinc-800 p-4 flex flex-col gap-1">
        <div className="text-lg font-semibold mb-4 px-2">
          <span className="text-cyan-400">▣</span> admin-ui
        </div>
        {NAV.map((n) => (
          <button
            key={n.name}
            onClick={() => go(n.name)}
            className={`text-left text-sm px-3 py-2 rounded transition ${
              route.name === n.name
                ? "bg-ink-800 text-cyan-300"
                : "text-zinc-300 hover:bg-ink-800"
            }`}
          >
            {n.label}
          </button>
        ))}
        <div className="mt-auto text-xs text-zinc-500 px-2">v0.1.0</div>
      </aside>
      <main className="flex-1 overflow-auto scroll-thin">
        {route.name === "home" && <Home />}
        {route.name === "runs" && <Runs onOpen={(ns) => go("run", ns)} />}
        {route.name === "run" && route.ns && <RunDetail ns={route.ns} onBack={() => go("runs")} />}
        {route.name === "launch" && <Launch onLaunched={(ns) => go("run", ns)} />}
        {route.name === "image" && <ImageProvider />}
        {route.name === "tts" && <Tts />}
        {route.name === "transcriber" && <Transcriber />}
        {route.name === "auth" && <Auth />}
      </main>
    </div>
  );
}
