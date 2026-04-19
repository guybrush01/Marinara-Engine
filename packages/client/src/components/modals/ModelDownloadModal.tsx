// ──────────────────────────────────────────────
// Model Download Modal
//
// Handles curated Gemma downloads plus BYO
// HuggingFace GGUF selection for the local
// llama-server sidecar runtime.
// ──────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { BrainCircuit, Check, Download, HardDrive, Loader2, Search, Server, X, Zap } from "lucide-react";
import { SIDECAR_MODELS, type SidecarQuantization } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal.js";
import { useSidecarStore } from "../../stores/sidecar.store.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function ModelDownloadModal({ open, onClose }: Props) {
  const {
    status,
    config,
    modelDownloaded,
    runtime,
    inferenceReady,
    logPath,
    downloadProgress,
    customModels,
    customModelsLoading,
    customModelsError,
    startDownload,
    startCustomDownload,
    listHuggingFaceModels,
    clearCustomModels,
    cancelDownload,
    unloadModel,
    markPrompted,
    fetchStatus,
  } = useSidecarStore();

  const [selectedQuant, setSelectedQuant] = useState<SidecarQuantization>("q8_0");
  const [repoInput, setRepoInput] = useState(config.customModelRepo ?? "unsloth/gemma-4-E2B-it-GGUF");
  const [selectedCustomPath, setSelectedCustomPath] = useState("");

  const isDownloading = downloadProgress?.status === "downloading";
  const hasModel = modelDownloaded;
  const activeModelName = useMemo(
    () => (hasModel ? (config.modelPath?.split("/").pop() ?? null) : null),
    [config.modelPath, hasModel],
  );
  const shouldAutoStart = config.useForGameScene;
  const isPreparingServer =
    hasModel && shouldAutoStart && !inferenceReady && (status === "starting_server" || status === "downloaded");
  const isSetupBusy = isDownloading || status === "downloading_runtime" || isPreparingServer;
  const canFinish = status === "ready" && inferenceReady;

  useEffect(() => {
    if (!open) {
      clearCustomModels();
      return;
    }

    void fetchStatus();
    if (config.customModelRepo) {
      setRepoInput(config.customModelRepo);
    }
  }, [open, config.customModelRepo, fetchStatus, clearCustomModels]);

  useEffect(() => {
    if (customModels.length > 0 && !customModels.some((entry) => entry.path === selectedCustomPath)) {
      setSelectedCustomPath(customModels[0]!.path);
    }
  }, [customModels, selectedCustomPath]);

  const progress = downloadProgress;
  const progressPercent = progress && progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0;
  const setupLabel =
    progress?.phase === "runtime"
      ? `Downloading llama.cpp runtime${progress.label ? ` (${progress.label})` : ""}...`
      : progress?.phase === "model"
        ? `Downloading model${progress.label ? ` (${progress.label})` : ""}...`
        : isPreparingServer
          ? "Starting local runtime..."
          : "Setting up local runtime...";
  const setupDescription =
    progress?.phase === "model"
      ? "Downloading your selected GGUF and preparing it for local use."
      : progress?.phase === "runtime"
        ? "Downloading the official llama.cpp runtime for this device."
        : "Loading the model and starting the local llama-server. This can take a few seconds.";
  const runtimeStatusLabel = canFinish
    ? "Ready"
    : isSetupBusy
      ? "Setting up now"
      : status === "server_error"
        ? "Setup error"
        : runtime.installed
          ? "Installed"
          : "Not downloaded yet";

  const handleSkip = () => {
    markPrompted();
    onClose();
  };

  const handleCuratedDownload = () => {
    markPrompted();
    void startDownload(selectedQuant);
  };

  const handleCustomDownload = () => {
    if (!repoInput.trim() || !selectedCustomPath) return;
    markPrompted();
    void startCustomDownload(repoInput.trim(), selectedCustomPath);
  };

  const handleListModels = async () => {
    await listHuggingFaceModels(repoInput.trim());
  };

  const handleDone = () => {
    markPrompted();
    onClose();
  };

  const handleCancelSetup = () => {
    if (isPreparingServer) {
      void unloadModel();
      return;
    }

    void cancelDownload();
  };

  return (
    <Modal open={open} onClose={isSetupBusy ? () => {} : onClose} title="Local AI Model" width="max-w-2xl">
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10">
            <BrainCircuit size="1.25rem" className="text-purple-400" />
          </div>
          <div className="text-sm text-[var(--muted-foreground)]">
            <p>
              Marinara Engine can run a local llama.cpp sidecar for trackers, scene analysis, and game-state helpers
              without spending main-model tokens.
            </p>
            <p className="mt-1.5 text-xs text-[var(--muted-foreground)]/70">
              Runtime downloads are automatic per platform. You can use the curated Gemma 4 presets or any GGUF hosted
              on HuggingFace.
            </p>
          </div>
        </div>

        {hasModel && (
          <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/15">
                <Check size="1rem" className="text-green-400" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-green-300">{activeModelName ?? "Model Installed"}</div>
                <div className="text-xs text-[var(--muted-foreground)]/70">
                  {config.customModelRepo
                    ? `Custom model from ${config.customModelRepo}`
                    : `${config.quantization?.toUpperCase() ?? "Curated"} Gemma 4 preset`}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Server size="0.95rem" className="text-purple-300" />
            Runtime
          </div>
          <div className="mt-2 flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
            <span>Status: {runtimeStatusLabel}</span>
            {isSetupBusy && (
              <span>
                Setup in progress. Marinara is still downloading the runtime or starting the local llama-server.
              </span>
            )}
            {runtime.installed && (
              <span>
                Runtime build: {runtime.build} • {runtime.variant}
              </span>
            )}
            {status === "server_error" && logPath && <span>Log: {logPath}</span>}
          </div>
        </div>

        {isSetupBusy && (
          <div className="rounded-xl border border-purple-400/25 bg-purple-500/5 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-500/15">
                <Loader2 size="1rem" className="animate-spin text-purple-300" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-purple-200">{setupLabel}</div>
                <div className="mt-1 text-xs text-[var(--muted-foreground)]/80">{setupDescription}</div>
              </div>
            </div>

            {progress ? (
              <div className="mt-4 flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                  <span>{setupLabel}</span>
                  <span>
                    {formatBytes(progress.downloaded)}
                    {progress.total > 0 && ` / ${formatBytes(progress.total)}`}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full bg-purple-400 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]/60">
                  <span>{progressPercent}%</span>
                  {progress.speed > 0 && <span>{formatSpeed(progress.speed)}</span>}
                </div>
              </div>
            ) : (
              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-purple-400/80" />
              </div>
            )}
          </div>
        )}

        {!isSetupBusy && (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]/60">
                Curated Gemma 4 Presets
              </span>
              {SIDECAR_MODELS.map((model) => (
                <label
                  key={model.quantization}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                    selectedQuant === model.quantization
                      ? "border-purple-400/50 bg-purple-500/5"
                      : "border-[var(--border)] hover:bg-[var(--secondary)]/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="quantization"
                    value={model.quantization}
                    checked={selectedQuant === model.quantization}
                    onChange={() => setSelectedQuant(model.quantization)}
                    className="sr-only"
                  />
                  <div
                    className={`h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
                      selectedQuant === model.quantization
                        ? "border-purple-400 bg-purple-400"
                        : "border-[var(--border)]"
                    }`}
                  >
                    {selectedQuant === model.quantization && (
                      <div className="flex h-full items-center justify-center">
                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{model.label}</div>
                    <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]/70">
                      <span className="flex items-center gap-1">
                        <Download size="0.75rem" />
                        {formatBytes(model.sizeBytes)}
                      </span>
                      <span className="flex items-center gap-1">
                        <HardDrive size="0.75rem" />~{formatBytes(model.ramBytes)} RAM
                      </span>
                    </div>
                  </div>
                  {model.quantization === "q8_0" && (
                    <span className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[0.625rem] font-medium text-purple-300">
                      Recommended
                    </span>
                  )}
                </label>
              ))}
              <button
                onClick={handleCuratedDownload}
                className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-purple-500/15 px-4 py-2.5 text-sm font-medium text-purple-300 transition-colors hover:bg-purple-500/25"
              >
                <Zap size="0.875rem" />
                {hasModel ? "Switch to Curated Model" : "Download Curated Model"}
              </button>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3">
              <div className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]/60">
                Use Your Own Model From HuggingFace
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex gap-2 max-sm:flex-col">
                  <input
                    value={repoInput}
                    onChange={(event) => setRepoInput(event.target.value)}
                    placeholder="owner/repo"
                    className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-sm outline-none transition-colors focus:border-purple-400/50"
                  />
                  <button
                    onClick={() => void handleListModels()}
                    disabled={!repoInput.trim() || customModelsLoading}
                    className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)] disabled:opacity-50"
                  >
                    {customModelsLoading ? (
                      <Loader2 size="0.875rem" className="animate-spin" />
                    ) : (
                      <Search size="0.875rem" />
                    )}
                    List Models
                  </button>
                </div>

                {customModelsError && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
                    {customModelsError}
                  </div>
                )}

                {customModels.length > 0 && (
                  <>
                    <select
                      value={selectedCustomPath}
                      onChange={(event) => setSelectedCustomPath(event.target.value)}
                      className="rounded-xl border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-sm outline-none transition-colors focus:border-purple-400/50"
                    >
                      {customModels.map((entry) => (
                        <option key={entry.path} value={entry.path}>
                          {entry.filename}
                          {entry.quantizationLabel ? ` • ${entry.quantizationLabel}` : ""}
                          {entry.sizeBytes ? ` • ${formatBytes(entry.sizeBytes)}` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleCustomDownload}
                      disabled={!selectedCustomPath}
                      className="flex items-center justify-center gap-2 rounded-xl bg-sky-500/15 px-4 py-2.5 text-sm font-medium text-sky-300 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
                    >
                      <Download size="0.875rem" />
                      {hasModel ? "Switch to Selected GGUF" : "Download Selected GGUF"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {progress?.status === "error" && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
            {progress.error || "Download failed. Please try again."}
          </div>
        )}

        <div className="flex items-center gap-2">
          {isSetupBusy ? (
            <button
              onClick={handleCancelSetup}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)]"
            >
              <X size="0.875rem" />
              Cancel Setup
            </button>
          ) : (
            <>
              <button
                onClick={handleSkip}
                className="flex-1 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)]"
              >
                {hasModel ? "Close" : "Skip for Now"}
              </button>
              <button
                onClick={handleDone}
                disabled={!canFinish}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-purple-500/15 px-4 py-2.5 text-sm font-medium text-purple-300 transition-colors hover:bg-purple-500/25 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-purple-500/15"
              >
                Done
              </button>
            </>
          )}
        </div>

        {!hasModel && !isSetupBusy && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]/60">
              What the local model handles
            </span>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--muted-foreground)]/80">
              <li>Tracker agents in roleplay mode</li>
              <li>Scene effects in game mode (backgrounds, music, SFX, ambient)</li>
              <li>Widget updates, weather, and time-of-day changes</li>
              <li>NPC reputation tracking and expression selection</li>
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
