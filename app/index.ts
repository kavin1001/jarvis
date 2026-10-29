import { registerRootComponent } from "expo";
import App from "./App";
// Defines the background task for place reminders; it has to exist before the app renders.
import "./src/geofence";

registerRootComponent(App);
