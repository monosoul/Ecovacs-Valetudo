"use strict";

const childProcess = require("child_process");

class MdsctlClient {
    /**
     * @param {object} options
     * @param {string} [options.binaryPath]
     * @param {string} [options.socketPath]
     * @param {number} [options.timeoutMs]
     */
    constructor(options = {}) {
        this.binaryPath = options.binaryPath ?? process.env.MDSCTL_PATH ?? "mdsctl";
        this.socketPath = options.socketPath ?? process.env.MDS_CMD_SOCKET ?? "/tmp/mds_cmd.sock";
        this.timeoutMs = options.timeoutMs ?? 2000;
    }

    /**
     * @param {string} element
     * @param {object} payload
     * @returns {Promise<void>}
     */
    async send(element, payload) {
        const args = [this.socketPath, element, JSON.stringify(payload)];
        await runCommandWithTimeout(this.binaryPath, args, this.timeoutMs);
    }
}

/**
 * @param {string} command
 * @param {Array<string>} args
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function runCommandWithTimeout(command, args, timeoutMs) {
    await new Promise((resolve, reject) => {
        const child = childProcess.spawn(command, args);
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });
        child.once("error", err => {
            clearTimeout(timer);
            reject(err);
        });
        child.once("close", code => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`mdsctl timed out after ${timeoutMs}ms`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`mdsctl failed (${code}) stdout=${stdout.trim()} stderr=${stderr.trim()}`));
                return;
            }
            resolve();
        });
    });
}

module.exports = MdsctlClient;
