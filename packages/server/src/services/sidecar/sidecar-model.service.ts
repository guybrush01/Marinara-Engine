// ──────────────────────────────────────────────
// Sidecar Local Model — Model Lifecycle Service
//
// Owns the persisted sidecar config plus GGUF
// download/list/delete flows for curated and
// custom HuggingFace models.
// ──────────────────────────────────────────────

import { basename, join, relative, resolve, sep } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import {
  SIDECAR_DEFAULT_CONFIG,
  SIDECAR_MODELS,
  type SidecarConfig,
  type SidecarCustomModelEntry,
  type SidecarDownloadProgress,
  type SidecarQuantization,
  type SidecarStatus,
  type SidecarStatusResponse,
} from "@marinara-engine/shared";
import { getDataDir } from "../../utils/data-dir.js";
import { downloadFileWithProgress, fetchJson, isAbortError } from "./sidecar-download.js";
import { sidecarRuntimeService } from "./sidecar-runtime.service.js";

export const MODELS_DIR = join(getDataDir(), "models");
export const CUSTOM_MODELS_DIR = join(MODELS_DIR, "custom");
export const CONFIG_PATH = join(MODELS_DIR, "sidecar-config.json");
export const LEGACY_RUNTIME_STAMP_PATH = join(MODELS_DIR, "sidecar-runtime-stamp.txt");

type ProgressCallback = (progress: SidecarDownloadProgress) => void;

interface HuggingFaceTreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { size?: number };
}

function normalizeRepoPath(repo: string): string {
  return repo.trim().replace(/^\/+|\/+$/g, "");
}

function isValidRepoPath(repo: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(repo);
}

function buildHuggingFaceDownloadUrl(repo: string, modelPath: string): string {
  const encodedPath = modelPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://huggingface.co/${repo}/resolve/main/${encodedPath}`;
}

function slugifyRepo(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "__");
}

function extractQuantizationLabel(filename: string): string | null {
  const stem = basename(filename, ".gguf");
  const match = stem.match(/(?:^|[-_.])(IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*)(?:$|[-_.])/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function ensureWithinModelsDir(targetPath: string): string {
  const resolvedRoot = resolve(MODELS_DIR);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error("Resolved model path escaped the sidecar models directory");
  }
  return resolvedTarget;
}

class SidecarModelService {
  private config: SidecarConfig;
  private status: SidecarStatus = "not_downloaded";
  private downloadAbort: AbortController | null = null;
  private progressListeners = new Set<ProgressCallback>();

  constructor() {
    mkdirSync(MODELS_DIR, { recursive: true });
    mkdirSync(CUSTOM_MODELS_DIR, { recursive: true });
    this.config = this.loadConfig();
    this.status = this.detectStatus();
  }

  private loadConfig(): SidecarConfig {
    let nextConfig: SidecarConfig = { ...SIDECAR_DEFAULT_CONFIG };
    let shouldRewrite = false;

    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<SidecarConfig>;
        nextConfig = { ...SIDECAR_DEFAULT_CONFIG, ...raw };

        // v1.5.x configs only tracked the curated quantization. Migrate them to an explicit modelPath.
        if (!nextConfig.modelPath && nextConfig.quantization) {
          const curated = SIDECAR_MODELS.find((model) => model.quantization === nextConfig.quantization);
          nextConfig.modelPath = curated?.filename ?? null;
          shouldRewrite = true;
        }

        if (nextConfig.modelPath && !this.isSafeRelativeModelPath(nextConfig.modelPath)) {
          nextConfig.modelPath = null;
          nextConfig.quantization = null;
          nextConfig.customModelRepo = null;
          shouldRewrite = true;
        }
      }
    } catch {
      shouldRewrite = true;
      nextConfig = { ...SIDECAR_DEFAULT_CONFIG };
    }

    if (shouldRewrite) {
      this.writeConfig(nextConfig);
    }

    return nextConfig;
  }

  private writeConfig(config: SidecarConfig): void {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  }

  private saveConfig(): void {
    this.writeConfig(this.config);
  }

  private detectStatus(): SidecarStatus {
    return this.getModelFilePath() ? "downloaded" : "not_downloaded";
  }

  private isSafeRelativeModelPath(modelPath: string): boolean {
    try {
      const resolved = this.resolveModelPath(modelPath);
      const rel = relative(resolve(MODELS_DIR), resolved);
      return rel !== "" && !rel.startsWith("..") && !rel.split(/[\\/]/).includes("..");
    } catch {
      return false;
    }
  }

  private resolveModelPath(modelPath: string): string {
    return ensureWithinModelsDir(join(MODELS_DIR, modelPath));
  }

  private emitProgress(progress: SidecarDownloadProgress, inline?: ProgressCallback): void {
    inline?.(progress);
    for (const listener of this.progressListeners) {
      listener(progress);
    }
  }

  private buildModelErrorProgress(error: unknown): SidecarDownloadProgress {
    return {
      phase: "model",
      status: "error",
      downloaded: 0,
      total: 0,
      speed: 0,
      error: error instanceof Error ? error.message : "Model download failed",
    };
  }

  getStatus(): SidecarStatusResponse {
    const modelPath = this.getModelFilePath();
    let modelSize: number | null = null;

    if (modelPath) {
      try {
        modelSize = statSync(modelPath).size;
      } catch {
        modelSize = null;
      }
    }

    return {
      status: this.status,
      config: { ...this.config },
      modelDownloaded: modelPath !== null,
      modelSize,
      runtime: sidecarRuntimeService.getStatus(),
      logPath: sidecarRuntimeService.getLogPath(),
    };
  }

  getConfig(): SidecarConfig {
    return { ...this.config };
  }

  isEnabled(): boolean {
    return this.config.useForGameScene;
  }

  getModelFilePath(): string | null {
    if (!this.config.modelPath) return null;
    const resolved = this.resolveModelPath(this.config.modelPath);
    return existsSync(resolved) ? resolved : null;
  }

  getModelRelativePath(): string | null {
    return this.getModelFilePath() ? this.config.modelPath : null;
  }

  isReady(): boolean {
    return this.status === "ready" || this.status === "downloaded" || this.status === "starting_server";
  }

  updateConfig(
    partial: Partial<Pick<SidecarConfig, "useForTrackers" | "useForGameScene" | "contextSize" | "gpuLayers">>,
  ): SidecarConfig {
    this.config = { ...this.config, ...partial };
    this.saveConfig();
    if (this.status === "not_downloaded" && this.getModelFilePath()) {
      this.status = "downloaded";
    }
    return { ...this.config };
  }

  async download(quantization: SidecarQuantization, onProgress?: ProgressCallback): Promise<void> {
    const modelInfo = SIDECAR_MODELS.find((model) => model.quantization === quantization);
    if (!modelInfo) {
      throw new Error(`Unknown sidecar quantization: ${quantization}`);
    }

    const relativePath = modelInfo.filename;
    const destination = this.resolveModelPath(relativePath);
    if (existsSync(destination)) {
      this.config = {
        ...this.config,
        modelPath: relativePath,
        quantization,
        customModelRepo: null,
      };
      this.saveConfig();
      this.status = "downloaded";
      this.emitProgress(
        {
          phase: "model",
          status: "complete",
          downloaded: modelInfo.sizeBytes,
          total: modelInfo.sizeBytes,
          speed: 0,
          label: modelInfo.label,
        },
        onProgress,
      );
      return;
    }

    await this.downloadModelFile(
      {
        url: modelInfo.downloadUrl,
        relativePath,
        label: modelInfo.label,
      },
      onProgress,
    );

    this.config = {
      ...this.config,
      modelPath: relativePath,
      quantization,
      customModelRepo: null,
    };
    this.saveConfig();
    this.status = "downloaded";
  }

  async listHuggingFaceModels(repoInput: string): Promise<SidecarCustomModelEntry[]> {
    const repo = normalizeRepoPath(repoInput);
    if (!isValidRepoPath(repo)) {
      throw new Error("Repository must be in owner/repo format");
    }

    const entries = await this.fetchRepoTree(repo);
    const ggufEntries = entries.filter((entry) => entry.type === "file" && entry.path?.toLowerCase().endsWith(".gguf"));
    if (ggufEntries.length === 0) {
      return [];
    }

    return ggufEntries
      .map((entry) => {
        const path = entry.path!;
        return {
          path,
          filename: basename(path),
          sizeBytes: entry.size ?? entry.lfs?.size ?? null,
          quantizationLabel: extractQuantizationLabel(path),
          downloadUrl: buildHuggingFaceDownloadUrl(repo, path),
        } satisfies SidecarCustomModelEntry;
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }

  async downloadCustomModel(
    repoInput: string,
    modelPath: string,
    onProgress?: ProgressCallback,
  ): Promise<SidecarCustomModelEntry> {
    const repo = normalizeRepoPath(repoInput);
    if (!isValidRepoPath(repo)) {
      throw new Error("Repository must be in owner/repo format");
    }

    const models = await this.listHuggingFaceModels(repo);
    const selected = models.find((entry) => entry.path === modelPath || entry.filename === modelPath);
    if (!selected) {
      throw new Error("Selected GGUF was not found in that repository");
    }

    const relativePath = join("custom", `${slugifyRepo(repo)}__${selected.filename}`).replace(/\\/g, "/");
    const destination = this.resolveModelPath(relativePath);
    if (!existsSync(destination)) {
      await this.downloadModelFile(
        {
          url: selected.downloadUrl,
          relativePath,
          label: selected.filename,
        },
        onProgress,
      );
    } else {
      this.emitProgress(
        {
          phase: "model",
          status: "complete",
          downloaded: selected.sizeBytes ?? 0,
          total: selected.sizeBytes ?? 0,
          speed: 0,
          label: selected.filename,
        },
        onProgress,
      );
    }

    this.config = {
      ...this.config,
      modelPath: relativePath,
      quantization: null,
      customModelRepo: repo,
    };
    this.saveConfig();
    this.status = "downloaded";
    return selected;
  }

  private async fetchRepoTree(repo: string): Promise<HuggingFaceTreeEntry[]> {
    const attempts = [
      `https://huggingface.co/api/models/${repo}/tree/main?recursive=1`,
      `https://huggingface.co/api/models/${repo}/tree/master?recursive=1`,
    ];

    let lastError: unknown;
    for (const url of attempts) {
      try {
        return await fetchJson<HuggingFaceTreeEntry[]>(url);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to load HuggingFace repository tree");
  }

  private async downloadModelFile(
    input: { url: string; relativePath: string; label: string },
    onProgress?: ProgressCallback,
  ): Promise<void> {
    if (this.downloadAbort) {
      throw new Error("Another sidecar download is already in progress");
    }

    this.status = "downloading_model";
    this.downloadAbort = new AbortController();
    const destination = this.resolveModelPath(input.relativePath);

    try {
      await downloadFileWithProgress({
        url: input.url,
        destPath: destination,
        signal: this.downloadAbort.signal,
        progress: {
          phase: "model",
          label: input.label,
        },
        onProgress: (progress) => this.emitProgress(progress, onProgress),
      });
    } catch (error) {
      this.status = this.detectStatus();
      if (isAbortError(error)) {
        throw new Error("Download cancelled");
      }

      const progress = this.buildModelErrorProgress(error);
      this.emitProgress(progress, onProgress);
      throw error;
    } finally {
      this.downloadAbort = null;
    }
  }

  cancelDownload(): void {
    this.downloadAbort?.abort();
    this.downloadAbort = null;
  }

  deleteModel(): void {
    const modelPath = this.getModelFilePath();
    if (modelPath && existsSync(modelPath)) {
      unlinkSync(modelPath);
    }

    this.config = {
      ...this.config,
      modelPath: null,
      quantization: null,
      customModelRepo: null,
    };
    this.saveConfig();
    this.status = "not_downloaded";
  }

  addProgressListener(callback: ProgressCallback): void {
    this.progressListeners.add(callback);
  }

  removeProgressListener(callback: ProgressCallback): void {
    this.progressListeners.delete(callback);
  }

  setStatus(status: SidecarStatus): void {
    this.status = status;
  }

  emitExternalProgress(progress: SidecarDownloadProgress): void {
    this.emitProgress(progress);
  }

  clearLegacyRuntimeStamp(): void {
    try {
      if (existsSync(LEGACY_RUNTIME_STAMP_PATH)) {
        unlinkSync(LEGACY_RUNTIME_STAMP_PATH);
      }
    } catch {
      // Best-effort cleanup for v1.5.x build stamp residue.
    }
  }
}

export const sidecarModelService = new SidecarModelService();
