"use strict";

const SOUND_I_AM_HERE = 30;
const SOUND_BEEP = 17;

class EcovacsSoundService {
    /**
     * @param {object} options
     * @param {import("./MdsctlClient")} options.mdsctlClient
     */
    constructor(options) {
        this.mdsctlClient = options.mdsctlClient;
    }

    /**
     * @returns {Promise<void>}
     */
    async playLocateSound() {
        await this.playSound(SOUND_I_AM_HERE);
    }

    /**
     * @returns {Promise<void>}
     */
    async playBeep() {
        await this.playSound(SOUND_BEEP);
    }

    /**
     * @param {number} fileNumber
     * @returns {Promise<void>}
     */
    async playSound(fileNumber) {
        if (!Number.isFinite(fileNumber)) {
            throw new Error(`Invalid sound file number: ${fileNumber}`);
        }
        await this.mdsctlClient.send("audio0", {
            todo: "audio",
            cmd: "play",
            file_number: Math.trunc(fileNumber)
        });
    }
}

module.exports = EcovacsSoundService;
