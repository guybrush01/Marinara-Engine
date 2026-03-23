import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CSSProperties } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Generate a unique ID, with fallback for insecure contexts (non-HTTPS). */
export function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Avatar crop data stored in character extensions. */
export interface AvatarCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Returns inline styles for a cropped/zoomed avatar image.
 *  The parent container must have `overflow: hidden`. */
export function getAvatarCropStyle(crop?: AvatarCrop | null): CSSProperties {
  if (!crop || crop.zoom <= 1) return {};
  return {
    transform: `scale(${crop.zoom}) translate(${crop.offsetX}%, ${crop.offsetY}%)`,
  };
}
