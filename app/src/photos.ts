import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { ActionSheetIOS, Platform } from "react-native";
import { Alert } from "./dialog";
import { chooseDocuments, type Doc } from "./documents";

export interface Photo {
  uri: string; // for the preview
  media_type: "image/jpeg";
  data: string; // base64
}

// Claude reads images best at up to ~1568 px on the long edge; bigger only costs tokens.
const MAX_EDGE = 1568;

async function prepare(asset: ImagePicker.ImagePickerAsset): Promise<Photo> {
  const scale = Math.min(1, MAX_EDGE / Math.max(asset.width, asset.height));
  const context = ImageManipulator.manipulate(asset.uri);
  if (scale < 1) context.resize({ width: Math.round(asset.width * scale) });
  const image = await context.renderAsync();
  const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
  return { uri: result.uri, media_type: "image/jpeg", data: result.base64! };
}

async function pick(source: "camera" | "library"): Promise<Photo[]> {
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Permission needed", `Allow ${source === "camera" ? "camera" : "photo"} access in Settings to share images with Jarvis.`);
    return [];
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsMultipleSelection: source === "library", selectionLimit: 4 };
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, 4).map(prepare));
}

export interface Attachments {
  photos: Photo[];
  docs: Doc[];
  /** The user chose to record a meeting instead. */
  meeting?: boolean;
}

/** Asks camera, library, file or meeting recording, then returns resized JPEGs or documents ready to send. */
export function chooseAttachments(): Promise<Attachments> {
  return new Promise((resolve) => {
    const choose = (i: number) =>
      resolve(
        i === 0
          ? pick("camera").then((photos) => ({ photos, docs: [] }))
          : i === 1
            ? pick("library").then((photos) => ({ photos, docs: [] }))
            : i === 2
              ? chooseDocuments().then((docs) => ({ photos: [], docs }))
              : Promise.resolve({ photos: [], docs: [], meeting: i === 3 }),
      );
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Take photo", "Choose from library", "Choose a file (PDF or text)", "Record a meeting", "Cancel"], cancelButtonIndex: 4 },
        choose,
      );
    } else {
      Alert.alert("Add an attachment", undefined, [
        { text: "Take photo", onPress: () => choose(0) },
        { text: "Choose from library", onPress: () => choose(1) },
        { text: "Choose a file (PDF or text)", onPress: () => choose(2) },
        { text: "Record a meeting", onPress: () => choose(3) },
        { text: "Cancel", style: "cancel", onPress: () => choose(4) },
      ]);
    }
  });
}
