import { createApp } from "vue";

import App from "./App.vue";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Polyptic player: missing #root element");
}

createApp(App).mount(root);
