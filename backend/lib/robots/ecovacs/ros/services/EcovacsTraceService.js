"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");

const SERVICE = {
    md5: "9760daeffedcd8659af2b5cda59a76c1",
    name: "/map/ManipulateTrace"
};

class EcovacsTraceService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.traceClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICE.name,
            serviceMd5: SERVICE.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug
        });
    }

    async shutdown() {
        await this.traceClient.shutdown();
    }

    /**
     * @param {number} mapId
     * @param {number} tailCount
     * @returns {Promise<any>}
     */
    async getTraceLatest(mapId, tailCount) {
        const traceInfoRequest = Buffer.alloc(13);
        traceInfoRequest.writeUInt8(1, 0); // GET_TRACE_INFO
        traceInfoRequest.writeUInt32LE(mapId >>> 0, 1);
        traceInfoRequest.writeUInt32LE(0, 5);
        traceInfoRequest.writeUInt32LE(0, 9);
        const infoBody = await this.traceClient.call(traceInfoRequest);
        const traceInfo = parseTraceResponse(infoBody);

        const endIdx = Number(traceInfo.endIdx);

        // 0xFFFFFFFF means the trace is being reset (e.g. cleaning just started);
        // no data is available yet so skip the range fetch.
        if (endIdx === 0 || endIdx >= 0xFFFFFFF0) {
            return null;
        }

        const startIdx = Math.max(0, endIdx - Math.max(1, tailCount));

        const traceRangeRequest = Buffer.alloc(13);
        traceRangeRequest.writeUInt8(0, 0); // GET_TRACE_BETWEEN_IDX
        traceRangeRequest.writeUInt32LE(mapId >>> 0, 1);
        traceRangeRequest.writeUInt32LE(startIdx >>> 0, 5);
        traceRangeRequest.writeUInt32LE(endIdx >>> 0, 9);
        const rangeBody = await this.traceClient.call(traceRangeRequest);
        const range = parseTraceResponse(rangeBody);
        const raw = range.data;

        return {
            source: "manipulate_trace_service_raw",
            trace_end_idx: endIdx,
            trace_start_idx: startIdx,
            trace_mapid: range.mapid,
            trace_raw_len: raw.length,
            trace_raw_hex: raw.toString("hex"),
            trace_decode_error: "disabled on robot (raw payload mode)"
        };
    }
}

/**
 * @param {Buffer} body
 * @returns {{result:number,mapid:number,traceId:number,startIdx:number,endIdx:number,data:Buffer}}
 */
function parseTraceResponse(body) {
    const cursor = new BinaryCursor(body);

    return {
        result: cursor.readUInt8(),
        mapid: cursor.readUInt32LE(),
        traceId: cursor.readUInt32LE(),
        startIdx: cursor.readUInt32LE(),
        endIdx: cursor.readUInt32LE(),
        data: cursor.readBuffer(cursor.readUInt32LE())
    };
}

module.exports = EcovacsTraceService;
