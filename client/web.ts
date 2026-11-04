import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const navigator: { clipboard?: { writeText(value: string): Promise<void> } };
export async function copyText(value: string): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch { return false; }
}

declare const Blob: { new(parts: string[], options: { type: string }): unknown };
declare const URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
declare const document: { createElement(tag: "a"): { href: string; download: string; click(): void; remove(): void }; body: { appendChild(node: unknown): void } };
export function downloadText(parts: string[], filename: string): boolean {
  if (Platform.OS !== "web") return false;
  let url: string | undefined;
  try {
    url = URL.createObjectURL(new Blob(parts, { type: "application/x-ndjson;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return true;
  } catch { if (url) URL.revokeObjectURL(url); return false; }
}
