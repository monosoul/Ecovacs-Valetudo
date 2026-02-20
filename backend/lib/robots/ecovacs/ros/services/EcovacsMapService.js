"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const Logger = require("../../../../Logger");
const PersistentServiceClient = require("../core/PersistentServiceClient");

const SERVICES = {
    map: {
        md5: "17d5f22724c41493b1778b9d79687330",
        name: "/map/GetCurrentCompressMap"
    },
    mapInfos: {
        md5: "2ebf09047aac00d6fc33c09a6a883453",
        name: "/map/ManipulateMapInfos"
    }
};

class EcovacsMapService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.mapClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICES.map.name,
            serviceMd5: SERVICES.map.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug
        });
        this.mapInfosClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICES.mapInfos.name,
            serviceMd5: SERVICES.mapInfos.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug,
            persistent: false
        });
    }

    async shutdown() {
        await Promise.all([
            this.mapClient.shutdown(),
            this.mapInfosClient.shutdown()
        ]);
    }

    /**
     * Get the active map ID from the robot by calling /map/ManipulateMapInfos.
     * Returns the mapid of the active map, or null if no active map is found.
     *
     * @returns {Promise<number|null>}
     */
    async getActiveMapId() {
        const request = Buffer.alloc(1);
        request.writeUInt8(0, 0); // type=0 means GET_MUTI_MAPINFOS

        const body = await this.mapInfosClient.call(request);

        return parseActiveMapIdFromMapInfos(body);
    }

    /**
     * @param {number} mapId
     * @returns {Promise<{result:number,mapid:number,info:{mapWidth:number,mapHeight:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolution:number},submaps:Array<{submapid:number,crc32:number,length:number,data:Buffer}>}>}
     */
    async getCompressedMap(mapId) {
        const request = Buffer.alloc(5);
        request.writeUInt8(0, 0);
        request.writeUInt32LE(mapId >>> 0, 1);
        const body = await this.mapClient.call(request);

        return parseGetCurrentCompressMapResponse(body);
    }
}

/**
 * Parse ManipulateMapInfos response to extract the active map ID.
 *
 * Wire format (firmware-specific, differs from genpy definition):
 *   result  (u8)
 *   count   (u32)   - number of map slots (typically 4)
 *   For each entry:
 *     mapid         (u32)
 *     extra_id      (u32)   - firmware-added field not in .msg definition
 *     isActive      (u8)
 *     slot_index    (u8)    - 0-based slot index
 *     isRecentMap   (u8)
 *     mapName       (u32 length + chars)  - ROS string
 *
 * @param {Buffer} body
 * @returns {number|null} Active map ID, or null if none found
 */
function parseActiveMapIdFromMapInfos(body) {
    if (body.length < 5) {
        Logger.warn("ManipulateMapInfos response too short");
        return null;
    }

    const cursor = new BinaryCursor(body);
    const result = cursor.readUInt8();
    const count = cursor.readUInt32LE();

    if (result !== 0) {
        Logger.warn(`ManipulateMapInfos returned error result: ${result}`);
        return null;
    }

    for (let i = 0; i < count; i++) {
        if (cursor.remaining() < 11) {
            Logger.warn(`ManipulateMapInfos entry ${i} truncated at fixed fields`);
            break;
        }

        const mapid = cursor.readUInt32LE();
        const extraId = cursor.readUInt32LE();
        const isActive = cursor.readUInt8();
        const slotIndex = cursor.readUInt8();
        cursor.readUInt8(); // isRecentMap - not used

        // Read ROS string: u32 length + data
        if (cursor.remaining() < 4) {
            Logger.warn(`ManipulateMapInfos entry ${i} truncated at mapName length`);
            break;
        }
        const nameLen = cursor.readUInt32LE();
        if (cursor.remaining() < nameLen) {
            Logger.warn(`ManipulateMapInfos entry ${i} truncated at mapName data`);
            break;
        }
        const nameBuffer = cursor.readBuffer(nameLen);
        const mapName = nameBuffer.toString("utf8");

        // Check if this is the active map
        if (isActive === 1 && mapid !== 0) {
            Logger.debug(`Found active map: id=${mapid}, name="${mapName}", slot=${slotIndex}, extraId=0x${extraId.toString(16)}`);
            return mapid;
        }
    }

    Logger.warn("No active map found in ManipulateMapInfos response");
    return null;
}

/**
 * @param {Buffer} body
 * @returns {{result:number,mapid:number,info:{mapWidth:number,mapHeight:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolution:number},submaps:Array<{submapid:number,crc32:number,length:number,data:Buffer}>}}
 */
function parseGetCurrentCompressMapResponse(body) {
    const cursor = new BinaryCursor(body);
    const result = cursor.readUInt8();
    const mapid = cursor.readUInt32LE();
    const info = {
        mapWidth: cursor.readUInt16LE(),
        mapHeight: cursor.readUInt16LE(),
        columns: cursor.readUInt16LE(),
        rows: cursor.readUInt16LE(),
        submapWidth: cursor.readUInt16LE(),
        submapHeight: cursor.readUInt16LE(),
        resolution: cursor.readUInt16LE()
    };
    const count = cursor.readUInt32LE();
    const submaps = [];
    for (let i = 0; i < count; i++) {
        const submapid = cursor.readUInt16LE();
        const crc32 = cursor.readUInt32LE();
        const length = cursor.readUInt32LE();
        const dataLen = cursor.readUInt32LE();
        const data = cursor.readBuffer(dataLen);
        submaps.push({
            submapid: submapid,
            crc32: crc32,
            length: length,
            data: data
        });
    }

    return {
        result: result,
        mapid: mapid,
        info: info,
        submaps: submaps
    };
}

module.exports = EcovacsMapService;
