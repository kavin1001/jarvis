import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { Alert } from "./dialog";

export interface Doc {
  name: string;
  media_type: "application/pdf" | "text/plain";
  data: string; // base64
}

// Claude reads PDFs (text and page images) and plain text. 20 MB keeps the request under the backend's limit.
const MAX_BYTES = 20 * 1024 * 1024;
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];

/** Picks up to 2 PDFs or text files, ready to send. */
export async function chooseDocuments(): Promise<Doc[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["application/pdf", ...TEXT_TYPES],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  const docs: Doc[] = [];
  for (const asset of result.assets.slice(0, 2)) {
    if ((asset.size ?? 0) > MAX_BYTES) {
      Alert.alert("File too large", `${asset.name} is over 20 MB.`);
      continue;
    }
    const isPdf = asset.mimeType === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf");
    const data =
      Platform.OS === "web"
        ? (asset.base64 ?? asset.uri).replace(/^data:[^,]*,/, "")
        : await new File(asset.uri).base64();
    docs.push({ name: asset.name, media_type: isPdf ? "application/pdf" : "text/plain", data });
  }
  return docs;
}
