const GithubValetudoUpdateProvider = require("./GithubValetudoUpdateProvider");
const {get} = require("../UpdaterUtils");

/**
 * Behaves exactly like the GithubValetudoUpdateProvider but fetches the releases overview from a
 * user-configurable base URL instead of the hardcoded github.com one.
 *
 * This is intended to be used together with a reverse proxy that mirrors a GitHub releases API
 * (e.g. the ha-valetudo-update-companion Home Assistant add-on), which makes fork releases
 * reachable from networks without direct internet access to github.com.
 *
 * As the proxy is expected to mimic the GitHub releases API 1:1 (rewriting the nested release- and
 * asset-URLs to point back at itself), the inherited fetchBinariesForRelease() and
 * parseReleaseOverviewApiResponse() can be reused unchanged.
 */
class SelfHostedValetudoUpdateProvider extends GithubValetudoUpdateProvider {
    /**
     * @param {object} [options]
     * @param {object} [options.implementationSpecificConfig]
     * @param {string} [options.implementationSpecificConfig.url]
     */
    constructor(options = {}) {
        super();

        this.releasesUrl = options?.implementationSpecificConfig?.url;
    }

    /**
     * @return {Promise<Array<import("./ValetudoRelease")>>}
     */
    async fetchReleases() {
        if (!this.releasesUrl) {
            throw new Error("SelfHostedValetudoUpdateProvider: Missing url in implementationSpecificConfig");
        }

        const rawReleasesResponse = await get(this.releasesUrl);

        if (!Array.isArray(rawReleasesResponse?.data)) {
            throw new Error("SelfHostedValetudoUpdateProvider: Received invalid releases response");
        }

        return this.parseReleaseOverviewApiResponse(rawReleasesResponse.data);
    }
}

SelfHostedValetudoUpdateProvider.TYPE = "self_hosted";

module.exports = SelfHostedValetudoUpdateProvider;
