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
