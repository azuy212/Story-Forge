import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type AppConfig } from "./api";

const ConfigContext = createContext<AppConfig | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): AppConfig {
  const ctx = useContext(ConfigContext);
  return ctx ?? { ttsProvider: "chatterbox", ttsEnabled: true };
}
