import { createApp } from "vue";

// Typography, SELF-HOSTED (POL-86). These used to come from fonts.googleapis.com, which broke the
// air-gap guarantee outright — a Polyptic box is meant to reach the control plane and nothing else
// (docs/DEPLOY.md: "the machine never touches the internet"), so on an isolated VLAN the request
// could only ever fail. It also cost us a real outage: on a boot where the network was still
// settling, Chrome aborted the in-flight font request with ERR_NETWORK_CHANGED alongside the
// content itself. Vite bundles these woff2 files into the player's own assets, so the wall now
// fetches its fonts from the same origin it fetches everything else from: the control plane.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import App from "./App.vue";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Polyptic player: missing #root element");
}

createApp(App).mount(root);
