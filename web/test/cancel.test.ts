import { afterEach, describe, expect, it, vi } from "vitest";
import { AdoClient } from "../src/core/adoClient";

const connection = { baseUrl: "https://dev.azure.com/org/", project: "project", getHeaders: async () => ({}) };

describe("AdoClient.withSignal", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("sends the signal with each request and stops once it's aborted", async () => {
        const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetch);
        const controller = new AbortController();
        const client = new AdoClient(connection).withSignal(controller.signal);

        await client.getRepositories();
        expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);

        controller.abort();
        await expect(client.getRepositories()).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
