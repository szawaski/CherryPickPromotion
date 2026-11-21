import { afterEach, describe, expect, it, vi } from "vitest";
import { AdoClient } from "../src/core/adoClient";

const client = new AdoClient({ baseUrl: "https://dev.azure.com/org/", project: "project", getHeaders: async () => ({}) });
const json = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? '{"value":[]}' : '{"message":"busy"}', { status, headers: { "content-type": "application/json", ...headers } });

/** Answers fetch with the statuses in turn, recording each request's method. */
function respond(...statuses: number[]) {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        methods.push(init.method ?? "GET");
        return json(statuses[Math.min(methods.length - 1, statuses.length - 1)]);
    });
    return methods;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("AdoClient retries", () => {
    it("tries a read again when Azure DevOps is briefly unavailable", async () => {
        vi.useFakeTimers();
        const methods = respond(503, 502, 200);
        const result = client.getRepositories();
        await vi.runAllTimersAsync();
        expect(await result).toEqual([]);
        expect(methods).toEqual(["GET", "GET", "GET"]);
    });

    it("gives up after three retries with the error", async () => {
        vi.useFakeTimers();
        const methods = respond(503);
        const result = client.getRepositories();
        const failed = expect(result).rejects.toThrow("returned 503");
        await vi.runAllTimersAsync();
        await failed;
        expect(methods).toHaveLength(4);
    });

    it("retries a write only when it was turned away, never after a server error", async () => {
        vi.useFakeTimers();
        let methods = respond(429, 200);
        const pushed = client.pushCommit("repo", "branch", "old", { comment: "c", changes: [] });
        await vi.runAllTimersAsync();
        await pushed;
        expect(methods).toEqual(["POST", "POST"]);

        methods = respond(500, 200);
        await expect(client.pushCommit("repo", "branch", "old", { comment: "c", changes: [] })).rejects.toThrow("returned 500");
        expect(methods).toEqual(["POST"]);
    });

    it("waits as long as Retry-After asks", async () => {
        vi.useFakeTimers();
        let calls = 0;
        vi.stubGlobal("fetch", async () => (++calls === 1 ? json(429, { "retry-after": "5" }) : json(200)));
        const result = client.getRepositories();
        await vi.advanceTimersByTimeAsync(4900);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(200);
        await result;
        expect(calls).toBe(2);
    });
});
