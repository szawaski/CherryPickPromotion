import { describe, expect, it } from "vitest";
import { combineBoth, originsOf, suggestFromText, suggestSide } from "../src/core/lineOrigins";
import type { GitCommitRef } from "../src/core/types";

const commit = (id: string, date: string): GitCommitRef => ({ commitId: id, comment: `commit ${id}\n\nbody`, author: { name: "Dev", email: "dev@example.com", date } });

// The file's versions, newest first: c changed line 2, b added line 4, a created it.
const history = [commit("c", "2026-10-03T00:00:00Z"), commit("b", "2026-10-02T00:00:00Z"), commit("a", "2026-10-01T00:00:00Z")];
const texts: Record<string, string> = {
    a: "one\ntwo\nthree\n",
    b: "one\ntwo\nthree\nfour\n",
    c: "one\nTWO\nthree\nfour\n"
};
const textAt = async (id: string) => texts[id];

describe("originsOf", () => {
    it("dates each line by the version it first appears in", async () => {
        const origins = await originsOf(texts.c, [0, 1, 2, 3], history, textAt, false);
        const ids = [0, 1, 2, 3].map(l => origins.get(l)?.commitId);
        expect(ids).toEqual(["a", "c", "a", "b"]);
        expect(origins.get(1)).toEqual({ commitId: "c", date: "2026-10-03T00:00:00Z", author: "Dev", message: "commit c" });
    });

    it("follows lines that moved because others were added above them", async () => {
        const moved: Record<string, string> = { a: "x\ny\n", b: "new\nx\ny\n" };
        const origins = await originsOf(moved.b, [2], [commit("b", "2026-10-02T00:00:00Z"), commit("a", "2026-10-01T00:00:00Z")], async id => moved[id], false);
        expect(origins.get(2)?.commitId).toBe("a");
    });

    it("stops reading older versions once every wanted line is dated", async () => {
        const read: string[] = [];
        await originsOf(texts.c, [1], history, async id => (read.push(id), texts[id]), false);
        expect(read).toEqual(["c", "b"]);
    });

    it("says a line is at least as old as the oldest version loaded when history was cut short", async () => {
        const origins = await originsOf(texts.c, [0], history, textAt, true);
        expect(origins.get(0)).toMatchObject({ commitId: "a", orAtLeast: true });
    });

    it("leaves lines the newest version doesn't have undated", async () => {
        const origins = await originsOf("one\nedited here\nthree\nfour\n", [1, 2], history, textAt, false);
        expect(origins.has(1)).toBe(false);
        expect(origins.get(2)?.commitId).toBe("a");
    });

    it("reads Windows line endings", async () => {
        const crlf = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.replace(/\n/g, "\r\n")]));
        const origins = await originsOf(crlf.c, [1, 3], history, async id => crlf[id], false);
        expect([origins.get(1)?.commitId, origins.get(3)?.commitId]).toEqual(["c", "b"]);
    });
});

describe("suggestSide", () => {
    const at = (id: string, date: string) => ({ commitId: id, date, author: "Dev", message: id });
    it("suggests the side whose newest line is newer", () => {
        expect(suggestSide([at("a", "2026-09-01T00:00:00Z"), at("b", "2026-10-06T00:00:00Z")], [at("c", "2026-09-18T00:00:00Z")])).toMatchObject({ side: "current", current: { commitId: "b" }, incoming: { commitId: "c" } });
        expect(suggestSide([at("a", "2026-09-01T00:00:00Z")], [at("c", "2026-09-18T00:00:00Z"), undefined])).toMatchObject({ side: "incoming" });
    });

    it("suggests nothing when a side has no dated lines or both are as new", () => {
        expect(suggestSide([], [at("c", "2026-09-18T00:00:00Z")])).toBeUndefined();
        expect(suggestSide([undefined], [at("c", "2026-09-18T00:00:00Z")])).toBeUndefined();
        expect(suggestSide([at("a", "2026-09-18T00:00:00Z")], [at("c", "2026-09-18T00:00:00Z")])).toBeUndefined();
    });
});

describe("suggestFromText", () => {
    it("suggests both when each side only added lines, keeping what they started from", () => {
        expect(suggestFromText([], ["new A"], ["new B"])).toEqual({ side: "both", why: "onlyAdded" });
        expect(suggestFromText(["end"], ["mine", "end"], ["end", "theirs"])).toEqual({ side: "both", why: "onlyAdded" });
    });

    it("suggests the side that already has every line of the other", () => {
        expect(suggestFromText(["x"], ["y", "x2", "z"], ["x2"])).toEqual({ side: "current", why: "contains" });
        expect(suggestFromText(["x"], ["x2"], ["x2", "more"])).toEqual({ side: "incoming", why: "contains" });
    });

    it("leaves it to the dates when a side replaced the other's lines", () => {
        expect(suggestFromText(["value = 1"], ["value = 2"], ["value = 3"])).toBeUndefined();
    });

    it("suggests the only side with lines, saying when the other removed what the base had", () => {
        // Release has none of the lines the incoming commit adds (a package block in a lock file, say).
        expect(suggestFromText([], [], ["added", "lines"])).toEqual({ side: "incoming", why: "onlySide", removed: false });
        // Current removed the base's lines while incoming changed them.
        expect(suggestFromText(["a"], [], ["b"])).toEqual({ side: "incoming", why: "onlySide", removed: true });
        expect(suggestFromText(["a"], ["b"], [])).toEqual({ side: "current", why: "onlySide", removed: true });
    });
});

describe("combineBoth", () => {
    it("puts the current side first, then the incoming side's additions, without repeating shared lines", () => {
        expect(combineBoth([], ["new A"], ["new B"])).toEqual(["new A", "new B"]);
        expect(combineBoth(["end"], ["mine", "end"], ["end", "theirs"])).toEqual(["mine", "end", "theirs"]);
    });

    it("adds the incoming side whole when it didn't keep the base", () => {
        expect(combineBoth(["x"], ["x", "a"], ["b"])).toEqual(["x", "a", "b"]);
    });
});

describe("suggestFromText with additions that read alike", () => {
    it("doesn't suggest both when the sides added two versions of the same entry", () => {
        // From run-sync-params.js: both kept the --reference line and added a --persist description, in different words.
        const base = ["//   --reference   the GL Reference Number the Payroll > Sage Intacct Time Cards dialog asks for (136419)"];
        const current = [
            base[0],
            "//   --jobs        the source-side Job/Location Ids filter (Spectrum to Time family); chips read back, REFUSED on a mismatch",
            "//   --persist     Persist Mode is the \"Save Changes\" checkbox on most syncs, checked by default: None unchecks",
            "//                 it (validate only), any other value checks it."
        ];
        const incoming = [
            base[0],
            "//   --persist     Persist Mode is now the \"Save Changes\" checkbox, checked by default: None unchecks it",
            "//                 (validate only), any other value checks it; read back, and the run is REFUSED on a mismatch"
        ];
        expect(suggestFromText(base, current, incoming)).toBeUndefined();
    });

    it("still suggests both for different additions that share a word or two", () => {
        expect(suggestFromText(["using A;", "using C;"], ["using A;", "using B;", "using C;"], ["using A;", "using Bee;", "using C;"])).toEqual({ side: "both", why: "onlyAdded" });
        expect(suggestFromText([], ["services.AddScoped<IPayrollWriter, PayrollWriter>();"], ["services.AddScoped<ITimeReader, TimeReader>();"])).toEqual({ side: "both", why: "onlyAdded" });
    });

    it("doesn't suggest both when both sides added the same line", () => {
        expect(suggestFromText([], ["x = 1;", "same line"], ["same line", "y = 2;"])).toBeUndefined();
    });
});
