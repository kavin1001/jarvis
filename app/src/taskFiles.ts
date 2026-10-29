import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { Settings, TaskFile } from "./api";

/**
 * Opens a file a background task made: on a phone it's downloaded to the cache and
 * handed to the share sheet (Save to Files, Numbers, Mail…); in a browser it downloads.
 */
export async function openTaskFile(settings: Settings, taskId: string, file: TaskFile) {
  const url = `${settings.url}/api/tasks/${taskId}/files/${encodeURIComponent(file.id)}`;
  const headers = { Authorization: `Bearer ${settings.token}` };
  if (Platform.OS === "web") {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await res.blob());
    link.download = file.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    return;
  }
  const dir = new Directory(Paths.cache, "task-files", taskId);
  if (!dir.exists) dir.create({ intermediates: true });
  // The agent picked the name; keep it to one safe path segment.
  const target = new File(dir, file.filename.replace(/[/\\]/g, "_") || "file");
  const saved = await File.downloadFileAsync(url, target, { headers, idempotent: true });
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(saved.uri, { mimeType: file.mime_type, dialogTitle: file.filename });
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
