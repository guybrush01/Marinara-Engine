import AdmZip from "adm-zip";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, relative, resolve, sep } from "path";
import type { SidecarDownloadProgress, SidecarRuntimeInfo } from "@marinara-engine/shared";
import { getDataDir } from "../../utils/data-dir.js";
import { downloadFileWithProgress, fetchJson, isAbortError, retry } from "./sidecar-download.js";

const execFileAsync = promisify(execFile);

const RUNTIME_DIR = join(getDataDir(), "sidecar-runtime");
const CURRENT_RUNTIME_PATH = join(RUNTIME_DIR, "current.json");
const SERVER_LOG_PATH = join(RUNTIME_DIR, "server.log");

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GitHubReleaseResponse {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

interface RuntimeRecord {
  build: string;
  variant: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  directoryName: string;
  serverRelativePath: string;
  installedAt: string;
}

export interface SidecarRuntimeInstall extends RuntimeRecord {
  directoryPath: string;
  serverPath: string;
}

interface RuntimeMatch {
  variant: string;
  asset: GitHubReleaseAsset;
}

interface RuntimeCapabilities {
  platform: NodeJS.Platform;
  arch: string;
  preferCuda: boolean;
  preferRocm: boolean;
  preferVulkan: boolean;
}

function ensureWithinRuntimeDir(targetPath: string): string {
  const root = resolve(RUNTIME_DIR);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget !== root && !resolvedTarget.startsWith(root + sep)) {
    throw new Error("Resolved runtime path escaped the sidecar runtime directory");
  }
  return resolvedTarget;
}

function compareVersionStrings(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function extractVersion(assetName: string): string {
  const match = assetName.match(/(?:cuda|rocm|openvino)-([0-9.]+)/i);
  return match?.[1] ?? "0";
}

function isWindowsAsset(assetName: string): boolean {
  return assetName.endsWith(".zip");
}

async function commandSucceeds(command: string, args: string[] = []): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function findExecutableRecursive(dirPath: string, expectedName: string): string | null {
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isFile()) {
      if (current.toLowerCase().endsWith(expectedName.toLowerCase())) {
        return current;
      }
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      stack.push(join(current, entry.name));
    }
  }
  return null;
}

class SidecarRuntimeService {
  private installPromise: Promise<SidecarRuntimeInstall> | null = null;
  private installAbort: AbortController | null = null;

  constructor() {
    mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  getLogPath(): string {
    return SERVER_LOG_PATH;
  }

  cancelInstall(): void {
    this.installAbort?.abort();
    this.installAbort = null;
  }

  getStatus(): SidecarRuntimeInfo {
    const current = this.getCurrentInstall();
    return {
      installed: current !== null,
      build: current?.build ?? null,
      variant: current?.variant ?? null,
    };
  }

  getCurrentInstall(): SidecarRuntimeInstall | null {
    if (!existsSync(CURRENT_RUNTIME_PATH)) {
      return null;
    }

    try {
      const record = JSON.parse(readFileSync(CURRENT_RUNTIME_PATH, "utf-8")) as RuntimeRecord;
      const directoryPath = ensureWithinRuntimeDir(join(RUNTIME_DIR, record.directoryName));
      const serverPath = ensureWithinRuntimeDir(join(directoryPath, record.serverRelativePath));
      if (!existsSync(serverPath)) {
        return null;
      }

      return {
        ...record,
        directoryPath,
        serverPath,
      };
    } catch {
      return null;
    }
  }

  async ensureInstalled(onProgress?: (progress: SidecarDownloadProgress) => void): Promise<SidecarRuntimeInstall> {
    const current = this.getCurrentInstall();
    if (current && this.isInstallUsable(current)) {
      return current;
    }

    if (this.installPromise) {
      return this.installPromise;
    }

    this.installPromise = this.installLatest(onProgress).finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private isInstallUsable(install: SidecarRuntimeInstall): boolean {
    return install.platform === process.platform && install.arch === process.arch && existsSync(install.serverPath);
  }

  private writeCurrentInstall(install: SidecarRuntimeInstall): void {
    const record: RuntimeRecord = {
      build: install.build,
      variant: install.variant,
      platform: install.platform,
      arch: install.arch,
      assetName: install.assetName,
      directoryName: install.directoryName,
      serverRelativePath: install.serverRelativePath,
      installedAt: install.installedAt,
    };
    writeFileSync(CURRENT_RUNTIME_PATH, JSON.stringify(record, null, 2), "utf-8");
  }

  private async installLatest(
    onProgress?: (progress: SidecarDownloadProgress) => void,
  ): Promise<SidecarRuntimeInstall> {
    const abortController = new AbortController();
    this.installAbort = abortController;

    let archivePath: string | null = null;
    let extractDirectory: string | null = null;
    let finalDirectory: string | null = null;

    try {
      const release = await retry(
        () =>
          fetchJson<GitHubReleaseResponse>("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
            signal: abortController.signal,
            headers: {
              Accept: "application/vnd.github+json",
            },
          }),
        {
          retries: 3,
          baseDelayMs: 500,
          shouldRetry: (error) => !isAbortError(error),
        },
      );

      const match = await this.selectBestAsset(release.assets);
      if (!match) {
        throw new Error(
          `Your platform (${process.platform}/${process.arch}) is not supported for local inference yet.`,
        );
      }

      const directoryName = `${release.tag_name}-${match.variant}`;
      finalDirectory = ensureWithinRuntimeDir(join(RUNTIME_DIR, directoryName));
      archivePath = ensureWithinRuntimeDir(join(RUNTIME_DIR, match.asset.name));
      extractDirectory = ensureWithinRuntimeDir(join(RUNTIME_DIR, `${directoryName}.extract`));

      if (existsSync(finalDirectory)) {
        rmSync(finalDirectory, { recursive: true, force: true });
      }

      await this.downloadAndExtractAsset({
        asset: match.asset,
        archivePath,
        extractDirectory,
        signal: abortController.signal,
        onProgress,
      });

      const executableName = isWindowsAsset(match.asset.name) ? "llama-server.exe" : "llama-server";
      const executablePath = findExecutableRecursive(extractDirectory, executableName);
      if (!executablePath) {
        throw new Error(`Could not find ${executableName} inside ${match.asset.name}`);
      }

      renameSync(extractDirectory, finalDirectory);
      const finalExecutable = ensureWithinRuntimeDir(join(finalDirectory, relative(extractDirectory, executablePath)));
      if (process.platform !== "win32") {
        try {
          chmodSync(finalExecutable, 0o755);
        } catch {
          // Best-effort on Unix-like systems.
        }
      }

      const install: SidecarRuntimeInstall = {
        build: release.tag_name,
        variant: match.variant,
        platform: process.platform,
        arch: process.arch,
        assetName: match.asset.name,
        directoryName,
        serverRelativePath: relative(finalDirectory, finalExecutable).replace(/\\/g, "/"),
        installedAt: new Date().toISOString(),
        directoryPath: finalDirectory,
        serverPath: finalExecutable,
      };
      this.writeCurrentInstall(install);
      return install;
    } catch (error) {
      if (extractDirectory) {
        rmSync(extractDirectory, { recursive: true, force: true });
      }
      if (finalDirectory) {
        rmSync(finalDirectory, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (archivePath) {
        rmSync(archivePath, { force: true });
      }
      if (this.installAbort === abortController) {
        this.installAbort = null;
      }
    }
  }

  private async downloadAndExtractAsset(options: {
    asset: GitHubReleaseAsset;
    archivePath: string;
    extractDirectory: string;
    signal: AbortSignal;
    onProgress?: (progress: SidecarDownloadProgress) => void;
  }): Promise<void> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      rmSync(options.extractDirectory, { recursive: true, force: true });
      mkdirSync(options.extractDirectory, { recursive: true });

      await retry(
        async () => {
          await downloadFileWithProgress({
            url: options.asset.browser_download_url,
            destPath: options.archivePath,
            signal: options.signal,
            progress: {
              phase: "runtime",
              label: options.asset.name,
            },
            onProgress: options.onProgress,
          });
        },
        {
          retries: 3,
          baseDelayMs: 750,
          shouldRetry: (error) => !isAbortError(error),
        },
      );

      try {
        await this.extractArchive(options.archivePath, options.extractDirectory);
        return;
      } catch (error) {
        lastError = error;
        rmSync(options.extractDirectory, { recursive: true, force: true });
        rmSync(options.archivePath, { force: true });
        if (attempt >= 2 || isAbortError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to extract ${options.asset.name}`);
  }

  private async extractArchive(archivePath: string, targetDir: string): Promise<void> {
    if (archivePath.endsWith(".zip")) {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(targetDir, true);
      return;
    }

    if (archivePath.endsWith(".tar.gz")) {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", targetDir], { timeout: 120_000 });
      return;
    }

    throw new Error(`Unsupported runtime archive format: ${archivePath}`);
  }

  private async detectCapabilities(): Promise<RuntimeCapabilities> {
    const platform = process.platform;
    const arch = process.arch;

    const preferCuda = arch === "x64" && (await commandSucceeds("nvidia-smi"));
    const preferRocm =
      platform === "linux" && arch === "x64" && ((await commandSucceeds("rocm-smi")) || existsSync("/opt/rocm"));
    const preferVulkan = await this.detectVulkanSupport(platform);

    return {
      platform,
      arch,
      preferCuda,
      preferRocm,
      preferVulkan,
    };
  }

  private async detectVulkanSupport(platform: NodeJS.Platform): Promise<boolean> {
    if (platform === "darwin" || platform === "android") {
      return false;
    }

    if (await commandSucceeds("vulkaninfo", ["--summary"])) {
      return true;
    }

    if (platform === "win32") {
      return existsSync("C:\\Windows\\System32\\vulkan-1.dll");
    }

    if (platform === "linux") {
      return ["/usr/lib/libvulkan.so", "/usr/lib64/libvulkan.so", "/usr/lib/x86_64-linux-gnu/libvulkan.so.1"].some(
        (path) => existsSync(path),
      );
    }

    return false;
  }

  private pickLatestVersionedAsset(
    assets: GitHubReleaseAsset[],
    pattern: RegExp,
    options?: { preferPrefix?: string },
  ): GitHubReleaseAsset | null {
    const matches = assets.filter((asset) => pattern.test(asset.name));
    if (matches.length === 0) {
      return null;
    }

    matches.sort((left, right) => {
      if (options?.preferPrefix) {
        const leftPref = left.name.startsWith(options.preferPrefix) ? 1 : 0;
        const rightPref = right.name.startsWith(options.preferPrefix) ? 1 : 0;
        if (leftPref !== rightPref) {
          return rightPref - leftPref;
        }
      }
      return compareVersionStrings(extractVersion(right.name), extractVersion(left.name));
    });

    return matches[0] ?? null;
  }

  private findFirstAsset(assets: GitHubReleaseAsset[], pattern: RegExp): GitHubReleaseAsset | null {
    return assets.find((asset) => pattern.test(asset.name)) ?? null;
  }

  private async selectBestAsset(assets: GitHubReleaseAsset[]): Promise<RuntimeMatch | null> {
    const capabilities = await this.detectCapabilities();
    const candidates: Array<() => RuntimeMatch | null> = [];

    if (capabilities.platform === "android" && capabilities.arch === "arm64") {
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-android-arm64\.tar\.gz$/i);
        return asset ? { variant: "android-arm64-cpu", asset } : null;
      });
    } else if (capabilities.platform === "darwin" && capabilities.arch === "arm64") {
      candidates.push(() => {
        const asset =
          this.findFirstAsset(assets, /^llama-.*-bin-macos-arm64\.tar\.gz$/i) ??
          this.findFirstAsset(assets, /^llama-.*-bin-macos-arm64-kleidiai\.tar\.gz$/i);
        return asset ? { variant: "macos-arm64-metal", asset } : null;
      });
    } else if (capabilities.platform === "darwin" && capabilities.arch === "x64") {
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-macos-x64\.tar\.gz$/i);
        return asset ? { variant: "macos-x64-cpu", asset } : null;
      });
    } else if (capabilities.platform === "win32" && capabilities.arch === "x64") {
      if (capabilities.preferCuda) {
        candidates.push(() => {
          const asset =
            this.pickLatestVersionedAsset(assets, /^(?:cudart-)?llama-.*-bin-win-cuda-[0-9.]+-x64\.zip$/i, {
              preferPrefix: "cudart-",
            }) ?? null;
          return asset ? { variant: "win-x64-cuda", asset } : null;
        });
      }
      if (capabilities.preferVulkan) {
        candidates.push(() => {
          const asset = this.findFirstAsset(assets, /^llama-.*-bin-win-vulkan-x64\.zip$/i);
          return asset ? { variant: "win-x64-vulkan", asset } : null;
        });
      }
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-win-cpu-x64\.zip$/i);
        return asset ? { variant: "win-x64-cpu", asset } : null;
      });
    } else if (capabilities.platform === "win32" && capabilities.arch === "arm64") {
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-win-cpu-arm64\.zip$/i);
        return asset ? { variant: "win-arm64-cpu", asset } : null;
      });
    } else if (capabilities.platform === "linux" && capabilities.arch === "x64") {
      if (capabilities.preferCuda) {
        candidates.push(() => {
          const asset = this.pickLatestVersionedAsset(assets, /^llama-.*-bin-ubuntu-cuda-[0-9.]+-x64\.tar\.gz$/i);
          return asset ? { variant: "linux-x64-cuda", asset } : null;
        });
      }
      if (capabilities.preferRocm) {
        candidates.push(() => {
          const asset = this.pickLatestVersionedAsset(assets, /^llama-.*-bin-ubuntu-rocm-[0-9.]+-x64\.tar\.gz$/i);
          return asset ? { variant: "linux-x64-rocm", asset } : null;
        });
      }
      if (capabilities.preferVulkan) {
        candidates.push(() => {
          const asset = this.findFirstAsset(assets, /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/i);
          return asset ? { variant: "linux-x64-vulkan", asset } : null;
        });
      }
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-ubuntu-x64\.tar\.gz$/i);
        return asset ? { variant: "linux-x64-cpu", asset } : null;
      });
    } else if (capabilities.platform === "linux" && capabilities.arch === "arm64") {
      if (capabilities.preferVulkan) {
        candidates.push(() => {
          const asset = this.findFirstAsset(assets, /^llama-.*-bin-ubuntu-vulkan-arm64\.tar\.gz$/i);
          return asset ? { variant: "linux-arm64-vulkan", asset } : null;
        });
      }
      candidates.push(() => {
        const asset = this.findFirstAsset(assets, /^llama-.*-bin-ubuntu-arm64\.tar\.gz$/i);
        return asset ? { variant: "linux-arm64-cpu", asset } : null;
      });
    }

    for (const pick of candidates) {
      const match = pick();
      if (match) {
        return match;
      }
    }

    return null;
  }
}

export const sidecarRuntimeService = new SidecarRuntimeService();
