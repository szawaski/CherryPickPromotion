import * as SDK from "azure-devops-extension-sdk";
import { createRoot } from "react-dom/client";
import { AdoClient } from "../core/adoClient";
import { App } from "../ui/App";

const gitResourceAreaId = "4e080c62-fa21-4fbc-8fef-2a10a2b38049";

interface LocationService {
    getResourceAreaLocation(resourceAreaId: string): Promise<string>;
}

async function start() {
    await SDK.init({ loaded: false, applyTheme: true });
    await SDK.ready();

    const locations = await SDK.getService<LocationService>("ms.vss-features.location-service");
    const baseUrl = await locations.getResourceAreaLocation(gitResourceAreaId);

    // Calls run as the signed-in user with the scopes granted in vss-extension.json.
    const client = new AdoClient({
        baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        project: SDK.getWebContext().project.name,
        getHeaders: async () => ({ Authorization: `Bearer ${await SDK.getAccessToken()}` })
    });

    createRoot(document.getElementById("root")!).render(<App client={client} />);
    await SDK.notifyLoadSucceeded();
}

start().catch(error => SDK.notifyLoadFailed(error instanceof Error ? error : String(error)));
