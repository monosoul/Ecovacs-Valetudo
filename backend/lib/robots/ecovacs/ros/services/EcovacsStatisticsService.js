"use strict";

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
    if (body.length < 12) {
        throw new Error(`GetLogInfo response too short: ${body.length} bytes`);
    }

    return {
        totalCnt: body.readUInt32LE(0),
        totalSecs: body.readUInt32LE(4),
        totalAreaM2: body.readUInt32LE(8)
    };
}

/**
 * @param {Buffer} body
 * @returns {{worktype:number, worktime:number, workareaM2:number, extraAreaM2:number, waterboxType:number, startTimeSecs:number}}
 */
function parseGetLastLogInfoResponse(body) {
    if (body.length < 30) {
        throw new Error(`GetLastLogInfo response too short: ${body.length} bytes`);
    }

    let offset = 0;
    const worktype = body.readUInt8(offset);
    offset += 1;
    const worktime = body.readUInt32LE(offset);
    offset += 4;
    const workarea = body.readUInt32LE(offset);
    offset += 4;
    const extraArea = body.readUInt32LE(offset);
    offset += 4;
    const waterboxType = body.readUInt8(offset);
    offset += 1;
    const startTimeSecs = body.readUInt32LE(offset);

    return {
        worktype: worktype,
        worktime: worktime,
        workareaM2: workarea,
        extraAreaM2: extraArea,
        waterboxType: waterboxType,
        startTimeSecs: startTimeSecs
    };
}

module.exports = EcovacsStatisticsService;
