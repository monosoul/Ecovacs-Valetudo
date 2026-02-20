"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {TopicStateSubscriber, decodeWorkStatisticToWifi} = require("../core/TopicStateSubscriber");

const SERVICES = {
    getLogInfo: {
        md5: "349803b37ad93c0069b0431de1bb30cc",
        name: "/worklog/GetLogInfo"
    },
    getLastLogInfo: {
        md5: "bf16b43980095bc05ef5a1ac5c002f5a",
        name: "/worklog/GetLastLogInfo"
    }
};

const TOPIC = {
    topic: "/worklog/WorkStatisticToWifi",
    type: "worklog/WorkStatisticToWifi",
    md5: "a54e1098445f2092ed11f984eeb3cf90",
    decoder: decodeWorkStatisticToWifi
};

class EcovacsStatisticsService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options) {
        this.getLogInfoClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICES.getLogInfo.name,
            serviceMd5: SERVICES.getLogInfo.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug,
            persistent: false
        });
        this.getLastLogInfoClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICES.getLastLogInfo.name,
            serviceMd5: SERVICES.getLastLogInfo.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug,
            persistent: false
        });
        this.workStatisticSubscriber = new TopicStateSubscriber({
            masterClient: options.masterClient,
            callerId: options.callerId,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn,
            safeResolve: true,
            reconnectDelayMs: 10_000,
            ...TOPIC
        });
    }

    async startup() {
        await this.workStatisticSubscriber.start();
    }

    async shutdown() {
        await Promise.all([
            this.workStatisticSubscriber.shutdown(),
            this.getLogInfoClient.shutdown(),
            this.getLastLogInfoClient.shutdown()
        ]);
    }

    /**
     * Get the latest work statistic from the topic subscriber cache.
     *
     * @param {number} staleMs
     * @returns {{worktype:number, worktime:number, workareaM2:number, extraAreaM2:number, waterboxType:number, startTimeSecs:number}|null}
     */
    getWorkStatistic(staleMs) {
        return this.workStatisticSubscriber.getLatestValue(staleMs);
    }

    /**
     * Get total cleaning statistics from /worklog/GetLogInfo.
     *
     * @returns {Promise<{totalCnt:number, totalSecs:number, totalAreaM2:number}>}
     */
    async getTotalStatistics() {
        const request = Buffer.alloc(1);
        request.writeUInt8(0, 0); // getType = 0
        const body = await this.getLogInfoClient.call(request);

        return parseGetLogInfoResponse(body);
    }

    /**
     * Get last cleaning session statistics from /worklog/GetLastLogInfo.
     *
     * @returns {Promise<{worktype:number, worktime:number, workareaM2:number, extraAreaM2:number, waterboxType:number, startTimeSecs:number}>}
     */
    async getLastCleanStatistics() {
        const request = Buffer.alloc(1);
        request.writeUInt8(0, 0); // getType = 0
        const body = await this.getLastLogInfoClient.call(request);

        return parseGetLastLogInfoResponse(body);
    }
}

/**
 * @param {Buffer} body
 * @returns {{totalCnt:number, totalSecs:number, totalAreaM2:number}}
 */
function parseGetLogInfoResponse(body) {
    const cursor = new BinaryCursor(body);

    return {
        totalCnt: cursor.readUInt32LE(),
        totalSecs: cursor.readUInt32LE(),
        totalAreaM2: cursor.readUInt32LE()
    };
}

/**
 * @param {Buffer} body
 * @returns {{worktype:number, worktime:number, workareaM2:number, extraAreaM2:number, waterboxType:number, startTimeSecs:number}}
 */
function parseGetLastLogInfoResponse(body) {
    const cursor = new BinaryCursor(body);

    return {
        worktype: cursor.readUInt8(),
        worktime: cursor.readUInt32LE(),
        workareaM2: cursor.readUInt32LE(),
        extraAreaM2: cursor.readUInt32LE(),
        waterboxType: cursor.readUInt8(),
        startTimeSecs: cursor.readUInt32LE()
    };
}

module.exports = EcovacsStatisticsService;
