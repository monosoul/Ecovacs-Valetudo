const assert = require("node:assert");
const { describe, it } = require("node:test");

const path = require("path");
const SelfHostedValetudoUpdateProvider = require("../../../../../lib/updater/lib/update_provider/SelfHostedValetudoUpdateProvider");
const {promises: fs} = require("fs");

// Fixtures are shared with the GithubValetudoUpdateProvider, as the self-hosted proxy mimics the
// GitHub releases API 1:1 and the parsing logic is inherited unchanged.
const FIXTURE_DIR = path.join(__dirname, "/res/GithubValetudoUpdateProvider");

describe("SelfHostedValetudoUpdateProvider", () => {
    it("stores the configured url as the releases url", () => {
        const updateProvider = new SelfHostedValetudoUpdateProvider({
            implementationSpecificConfig: {url: "http://192.168.1.1:8080/releases"}
        });

        assert.strictEqual(updateProvider.releasesUrl, "http://192.168.1.1:8080/releases");
    });

    it("fetchReleases rejects when no url is configured", async () => {
        const updateProvider = new SelfHostedValetudoUpdateProvider({implementationSpecificConfig: {}});

        await assert.rejects(() => updateProvider.fetchReleases(), /Missing url/);
    });

    it("construction without options does not throw", () => {
        assert.doesNotThrow(() => new SelfHostedValetudoUpdateProvider());
    });

    it("inherits the overview parsing from the github provider", async () => {
        const updateProvider = new SelfHostedValetudoUpdateProvider({
            implementationSpecificConfig: {url: "http://192.168.1.1:8080/releases"}
        });
        const data = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, "/regular_overview_response.json"), { encoding: "utf-8" }));
        const expected = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, "/correctly_parsed_regular_overview_response.json"), { encoding: "utf-8" }));
        const actual = updateProvider.parseReleaseOverviewApiResponse(data);

        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);
    });
});
