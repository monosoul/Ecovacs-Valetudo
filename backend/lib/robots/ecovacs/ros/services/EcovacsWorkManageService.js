"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const Logger = require("../../../../Logger");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {encodeUInt8Array, encodeUInt32, encodeFloat32} = require("../protocol/encoding");
const {WORK_TYPE} = require("../../EcovacsStateMapping");

const SERVICE = {
    md5: "07877d0b6f69402fce5b6b91983c66f7",
    name: "/task/WorkManage"
};

const WORK_MANAGE_TYPE = {
    START: 0,
    STOP: 1,
    PAUSE: 2,
    RESUME: 3
};

class EcovacsWorkManageService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.debug = options.debug ?? false;
        this.workClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICE.name,
            serviceMd5: SERVICE.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug,
            persistent: false
        });
    }

    async shutdown() {
        await this.workClient.shutdown();
    }

    /**
     * @returns {Promise<number>}
     */
    async startAutoClean() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.AUTO_CLEAN
            })
        );
    }

    /**
     * @returns {Promise<number>}
     */
    async stopCleaning() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.STOP,
                workType: WORK_TYPE.IDLE
            })
        );
    }

    /**
     * @param {number|null} [workType]
     * @returns {Promise<number>}
     */
    async pauseCleaning(workType) {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.PAUSE,
                workType: workType ?? WORK_TYPE.AUTO_CLEAN
            })
        );
    }

    /**
     * @param {number|null} [workType]
     * @returns {Promise<number>}
     */
    async resumeCleaning(workType) {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.RESUME,
                workType: workType ?? WORK_TYPE.AUTO_CLEAN
            })
        );
    }

    /**
     * @returns {Promise<number>}
     */
    async returnToDock() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.RETURN
            })
        );
    }

    /**
     * @returns {Promise<number>}
     */
    async autoCollectDirt() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.AUTO_COLLECT_DIRT
            })
        );
    }

    /**
     * @param {Array<number>} roomIds
     * @returns {Promise<number>}
     */
    async startRoomClean(roomIds) {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.AREA_CLEAN,
                cleanIds: roomIds
            })
        );
    }

    /**
     * @param {Array<[number,number,number,number]>} rects
     * @returns {Promise<number>}
     */
    async startCustomClean(rects) {
        const points = [];
        for (const [x1, y1, x2, y2] of rects) {
            points.push([Number(x1), Number(y1)], [Number(x2), Number(y2)]);
        }
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.CUSTOM_CLEAN,
                customAreaPoints: points
            })
        );
    }

    /**
     * @param {number} moveType
     * @param {number} [w]
     * @returns {Promise<number>}
     */
    async remoteMove(moveType, w = 0) {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.START,
                workType: WORK_TYPE.REMOTE_CONTROL,
                remoteMoveType: moveType,
                remoteW: w
            })
        );
    }

    /**
     * @param {Buffer} request
     * @returns {Promise<number>}
     */
    async callWorkManage(request) {
        if (this.debug) {
            Logger.info(
                `Ecovacs WorkManage request: bytes=${request.length} preview=${request.subarray(0, Math.min(24, request.length)).toString("hex")}`
            );
        }
        const body = await this.workClient.call(request);
        if (this.debug) {
            Logger.info(
                `Ecovacs WorkManage response: bytes=${body.length} hex=${body.toString("hex")}`
            );
        }

        return parseWorkManageResponse(body).response;
    }
}

/**
 * @param {object} options
 * @param {number} options.manageType
 * @param {number} options.workType
 * @param {Array<number>} [options.cleanIds]
 * @param {Array<[number,number]>} [options.customAreaPoints]
 * @param {number} [options.remoteMoveType]
 * @param {number} [options.remoteLastTime]
 * @param {number} [options.remoteV]
 * @param {number} [options.remoteW]
 * @returns {Buffer}
 */
function serializeWorkManageRequest(options) {
    const chunks = [];
    chunks.push(Buffer.from([options.manageType & 0xff, options.workType & 0xff]));
    chunks.push(encodeUInt8Array(options.cleanIds ?? []));
    const customAreaPoints = options.customAreaPoints ?? [];
    chunks.push(encodeUInt32(customAreaPoints.length));
    for (const [x, y] of customAreaPoints) {
        chunks.push(encodeFloat32(Number(x)));
        chunks.push(encodeFloat32(Number(y)));
    }
    chunks.push(encodeUInt8Array([])); // cycles
    chunks.push(encodeUInt8Array([])); // clean states
    chunks.push(encodeUInt8Array([])); // extra ids
    chunks.push(encodeUInt32(0)); // extra poses len

    const remoteMoveType = options.remoteMoveType ?? 0;
    const remoteLastTime = options.remoteLastTime ?? 0;
    const remoteV = options.remoteV ?? 0;
    const remoteW = options.remoteW ?? 0;
    const remote = Buffer.alloc(7);
    remote.writeUInt8(remoteMoveType & 0xff, 0);
    remote.writeUInt16LE(remoteLastTime & 0xffff, 1);
    remote.writeInt16LE(remoteV, 3);
    remote.writeInt16LE(remoteW, 5);
    chunks.push(remote);

    chunks.push(encodeUInt8Array([])); // extra states

    return Buffer.concat(chunks);
}

/**
 * @param {Buffer} body
 * @returns {{response:number}}
 */
function parseWorkManageResponse(body) {
    const cursor = new BinaryCursor(body);

    return {
        response: cursor.readUInt8()
    };
}

module.exports = EcovacsWorkManageService;
