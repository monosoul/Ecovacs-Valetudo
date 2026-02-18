"use strict";

class EcovacsRemoteSessionService {
    /**
     * @param {object} options
     * @param {import("./MdsctlClient")} options.mdsctlClient
     */
    constructor(options) {
        this.mdsctlClient = options.mdsctlClient;
    }

    /**
     * @param {string} code
     * @returns {Promise<void>}
     */
    async open(code) {
        if (!code) {
            throw new Error("remote-session-open requires a non-empty code");
        }
        await this.mdsctlClient.send("live_pwd", {
            todo: "setPwdState",
            state: 1
        });
        await this.mdsctlClient.send("live_pwd", {
            todo: "onLiveLaunchPwdState",
            state: 1,
            password: String(code)
        });
        await this.mdsctlClient.send("rosnode", {
            todo: "start_push_stream",
            light_state: 1
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async close() {
        await this.mdsctlClient.send("rosnode", {
            todo: "stop_push_stream"
        });
    }
}

module.exports = EcovacsRemoteSessionService;
