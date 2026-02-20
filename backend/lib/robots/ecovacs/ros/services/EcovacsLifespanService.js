"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");

const SERVICE = {
    md5: "35c020f6d3af5b57369fe7f26779c5d8",
    name: "/lifespan/lifespan"
};

const LIFESPAN_MANAGE_TYPE = Object.freeze({
    GET: 0,
    RESET: 1
});

const LIFESPAN_PART = Object.freeze({
    MAIN_BRUSH: 0,
    SIDE_BRUSH: 1,
    HEPA: 2,
    ALL: 3
});

class EcovacsLifespanService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.lifespanClient = new PersistentServiceClient({
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
        await this.lifespanClient.shutdown();
    }

    /**
     * @param {number} part
     * @returns {Promise<{result:number,life:Array<number>,total:Array<number>}>}
     */
    async getLifespan(part) {
        const request = serializeLifespanRequest({
            type: LIFESPAN_MANAGE_TYPE.GET,
            part: part
        });
        const body = await this.lifespanClient.call(request);

        return parseLifespanResponse(body);
    }

    /**
     * @param {number} part
     * @returns {Promise<{result:number,life:Array<number>,total:Array<number>}>}
     */
    async resetLifespan(part) {
        const request = serializeLifespanRequest({
            type: LIFESPAN_MANAGE_TYPE.RESET,
            part: part
        });
        const body = await this.lifespanClient.call(request);

        return parseLifespanResponse(body);
    }
}

/**
 * @param {{type:number,part:number}} options
 * @returns {Buffer}
 */
function serializeLifespanRequest(options) {
    return Buffer.from([
        options.type & 0xff,
        options.part & 0xff
    ]);
}

/**
 * @param {Buffer} body
 * @returns {{result:number,life:Array<number>,total:Array<number>}}
 */
function parseLifespanResponse(body) {
    const cursor = new BinaryCursor(body);
    const result = cursor.readUInt8();
    const lifeCount = cursor.readUInt32LE();
    /** @type {Array<number>} */
    const life = [];
    for (let i = 0; i < lifeCount; i++) {
        life.push(cursor.readUInt32LE());
    }
    const totalCount = cursor.readUInt32LE();
    /** @type {Array<number>} */
    const total = [];
    for (let i = 0; i < totalCount; i++) {
        total.push(cursor.readUInt32LE());
    }

    return {
        result: result,
        life: life,
        total: total
    };
}

module.exports = EcovacsLifespanService;
module.exports.LIFESPAN_PART = LIFESPAN_PART;
