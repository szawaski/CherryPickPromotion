import { createRoot } from "react-dom/client";
import { AdoClient } from "../core/adoClient";
import { App } from "../ui/App";

// Hosted by the WinForms app, which proxies /ado/ to the organization and adds the PAT itself.
const project = new URLSearchParams(window.location.search).get("project") ?? "";

const client = new AdoClient({
    baseUrl: `${window.location.origin}/ado/`,
    project,
    getHeaders: async () => ({})
});

createRoot(document.getElementById("root")!).render(<App client={client} />);
