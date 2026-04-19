// ──────────────────────────────────────────────
// Sidecar Store — Client state for the local
// llama-server runtime + GGUF model manager
// ──────────────────────────────────────────────

import { create } from "zustand";
import type {
  SidecarConfig,
  SidecarCustomModelEntry,
  SidecarDownloadProgress,
  SidecarRuntimeInfo,
  SidecarStatus,
  SidecarStatusResponse,
  SidecarQuantization,
} from "@marinara-engine/shared";
import { SIDECAR_DEFAULT_CONFIG } from "@marinara-engine/shared";
import { api } from "../lib/api-client.js";

interface SidecarState {
  status: SidecarStatus;
  config: SidecarConfig;
  modelDownloaded: boolean;
  runtime: SidecarRuntimeInfo;
  inferenceReady: boolean;
  modelSize: number | null;
  logPath: string | null;
  downloadProgress: SidecarDownloadProgress | null;
  customModels: SidecarCustomModelEntry[];
  customModelsLoading: boolean;
  customModelsError: string | null;
  showDownloadModal: boolean;
  hasBeenPrompted: boolean;

  fetchStatus: () => Promise<void>;
  startDownload: (quantization: SidecarQuantization) => Promise<void>;
  startCustomDownload: (repo: string, modelPath: string) => Promise<void>;
  listHuggingFaceModels: (repo: string) => Promise<SidecarCustomModelEntry[]>;
  clearCustomModels: () => void;
  cancelDownload: () => Promise<void>;
  deleteModel: () => Promise<void>;
  unloadModel: () => Promise<void>;
  updateConfig: (
    partial: Partial<Pick<SidecarConfig, "useForTrackers" | "useForGameScene" | "contextSize" | "gpuLayers">>,
  ) => Promise<void>;
  setShowDownloadModal: (open: boolean) => void;
  markPrompted: () => void;
}

const PROMPTED_KEY = "marinara_sidecar_prompted";
const TRANSITIONAL_STATUSES = new Set<SidecarStatus>(["downloading_runtime", "downloading_model", "starting_server"]);
let statusPollTimer: number | null = null;

function clearStatusPollTimer() {
  if (statusPollTimer !== null) {
    window.clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
}

function shouldKeepPolling(state: Pick<SidecarState, "status" | "config" | "inferenceReady">): boolean {
  if (TRANSITIONAL_STATUSES.has(state.status)) {
    return true;
  }

  if (state.status === "downloaded" && state.config.useForGameScene && !state.inferenceReady) {
    return true;
  }

  return false;
}

async function consumeDownloadStream(
  path: string,
  body: unknown,
  set: (partial: Partial<SidecarState>) => void,
  get: () => SidecarState,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    throw new Error("Download request failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6)) as Partial<SidecarDownloadProgress> & {
          done?: boolean;
          status?: string;
          error?: string;
        };

        if (data.done) {
          set({ downloadProgress: null });
          await get().fetchStatus();
          return;
        }

        if (data.status === "error") {
          set({
            downloadProgress: {
              phase: (data.phase as SidecarDownloadProgress["phase"]) ?? "model",
              status: "error",
              downloaded: 0,
              total: 0,
              speed: 0,
              error: data.error ?? "Download failed",
              label: data.label,
            },
          });
          await get().fetchStatus();
          return;
        }

        if (data.status === "downloading") {
          set({
            downloadProgress: {
              phase: (data.phase as SidecarDownloadProgress["phase"]) ?? "model",
              status: "downloading",
              downloaded: Number(data.downloaded ?? 0),
              total: Number(data.total ?? 0),
              speed: Number(data.speed ?? 0),
              label: data.label,
            },
            status: (data.phase === "runtime" ? "downloading_runtime" : "downloading_model") as SidecarStatus,
          });
        }
      } catch {
        // Ignore malformed SSE chunks.
      }
    }
  }

  set({ downloadProgress: null });
  await get().fetchStatus();
}

export const useSidecarStore = create<SidecarState>((set, get) => ({
  status: "not_downloaded",
  config: { ...SIDECAR_DEFAULT_CONFIG },
  modelDownloaded: false,
  runtime: { installed: false, build: null, variant: null },
  inferenceReady: false,
  modelSize: null,
  logPath: null,
  downloadProgress: null,
  customModels: [],
  customModelsLoading: false,
  customModelsError: null,
  showDownloadModal: false,
  hasBeenPrompted: localStorage.getItem(PROMPTED_KEY) === "true",

  fetchStatus: async () => {
    try {
      const response = await api.get<SidecarStatusResponse & { inferenceReady: boolean }>("/sidecar/status");
      const nextState = {
        status: response.status,
        config: response.config,
        modelDownloaded: response.modelDownloaded,
        runtime: response.runtime,
        inferenceReady: response.inferenceReady,
        modelSize: response.modelSize,
        logPath: response.logPath,
      };
      set(nextState);

      clearStatusPollTimer();
      if (shouldKeepPolling(nextState)) {
        statusPollTimer = window.setTimeout(() => {
          void get().fetchStatus();
        }, 1500);
      }
    } catch {
      // Best-effort: the server may not support sidecar yet.
    }
  },

  startDownload: async (quantization) => {
    set({
      status: "downloading_model",
      downloadProgress: {
        phase: "model",
        status: "downloading",
        downloaded: 0,
        total: 0,
        speed: 0,
      },
    });

    try {
      await consumeDownloadStream("/api/sidecar/download", { quantization }, set, get);
    } catch (error) {
      set({
        downloadProgress: {
          phase: "model",
          status: "error",
          downloaded: 0,
          total: 0,
          speed: 0,
          error: error instanceof Error ? error.message : "Download failed",
        },
      });
    }
  },

  startCustomDownload: async (repo, modelPath) => {
    set({
      status: "downloading_model",
      downloadProgress: {
        phase: "model",
        status: "downloading",
        downloaded: 0,
        total: 0,
        speed: 0,
      },
    });

    try {
      await consumeDownloadStream("/api/sidecar/download/custom", { repo, modelPath }, set, get);
    } catch (error) {
      set({
        downloadProgress: {
          phase: "model",
          status: "error",
          downloaded: 0,
          total: 0,
          speed: 0,
          error: error instanceof Error ? error.message : "Download failed",
        },
      });
    }
  },

  listHuggingFaceModels: async (repo) => {
    set({ customModelsLoading: true, customModelsError: null });
    try {
      const response = await api.post<{ models: SidecarCustomModelEntry[] }>("/sidecar/models/list-huggingface", {
        repo,
      });
      set({ customModels: response.models, customModelsLoading: false, customModelsError: null });
      return response.models;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list HuggingFace models";
      set({ customModels: [], customModelsLoading: false, customModelsError: message });
      throw error;
    }
  },

  clearCustomModels: () => {
    set({ customModels: [], customModelsError: null, customModelsLoading: false });
  },

  cancelDownload: async () => {
    try {
      await api.post("/sidecar/download/cancel");
    } catch {
      // Best-effort cancel.
    }

    set({ downloadProgress: null });
    await get().fetchStatus();
  },

  deleteModel: async () => {
    try {
      await api.delete("/sidecar/model");
      set({
        status: "not_downloaded",
        config: { ...SIDECAR_DEFAULT_CONFIG },
        modelDownloaded: false,
        inferenceReady: false,
        modelSize: null,
      });
      await get().fetchStatus();
    } catch {
      // Best-effort delete.
    }
  },

  unloadModel: async () => {
    try {
      await api.post("/sidecar/unload");
      await get().fetchStatus();
    } catch {
      // Best-effort unload.
    }
  },

  updateConfig: async (partial) => {
    const previous = get().config;
    set({ config: { ...previous, ...partial } });
    try {
      const response = await api.patch<{ config: SidecarConfig }>("/sidecar/config", partial);
      set({ config: response.config });
      void get().fetchStatus();
    } catch {
      set({ config: previous });
    }
  },

  setShowDownloadModal: (open) => set({ showDownloadModal: open }),

  markPrompted: () => {
    localStorage.setItem(PROMPTED_KEY, "true");
    set({ hasBeenPrompted: true });
  },
}));
