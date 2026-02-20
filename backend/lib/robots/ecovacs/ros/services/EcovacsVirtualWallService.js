"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {encodeUInt32, encodeFloat32} = require("../protocol/encoding");

const SERVICE = {
    md5: "5ac048cd1de2f92de83f97bf5aac52e9",
    name: "/map/ManipulateVirtualWall"
};

const VIRTUAL_WALL_TYPE = Object.freeze({
    NORMAL: 0,
    CARPET: 1
});

const VIRTUAL_WALL_MANIPULATE_TYPE = Object.freeze({
    ADD: 0,
    DELETE: 1,
    GET_ALL: 4,
    GET_BY_ID: 5
});

class EcovacsVirtualWallService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.virtualWallClient = new PersistentServiceClient({
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
        await this.virtualWallClient.shutdown();
    }

    /**
     * @param {number} mapId
     * @param {number} [scanMaxId]
     * @returns {Promise<Array<{vwid:number,type:number,dots:Array<[number,number]>}>>}
     */
    async getVirtualWalls(mapId, scanMaxId = -1) {
        const baseResponse = await this.callVirtualWall({
            type: VIRTUAL_WALL_MANIPULATE_TYPE.GET_ALL,
            mapId: mapId,
            vwid: 0xffffffff,
            walls: []
        });
        /** @type {Map<number, {vwid:number,type:number,dots:Array<[number,number]>}>} */
        const byId = new Map(baseResponse.vwalls.map(wall => [wall.vwid, wall]));
        const fetchIds = new Set(byId.keys());
        if (Number.isInteger(scanMaxId) && scanMaxId >= 0) {
            for (let i = 0; i <= scanMaxId; i++) {
                fetchIds.add(i);
            }
        }
        for (const vwid of fetchIds) {
            try {
                const byIdResponse = await this.callVirtualWall({
                    type: VIRTUAL_WALL_MANIPULATE_TYPE.GET_BY_ID,
                    mapId: mapId,
                    vwid: vwid,
                    walls: []
                });
                if (byIdResponse.result !== 0) {
                    continue;
                }
                for (const wall of byIdResponse.vwalls) {
                    byId.set(wall.vwid, wall);
                }
            } catch (e) {
                // tolerate not-found ids
            }
        }

        return Array.from(byId.values()).sort((a, b) => a.vwid - b.vwid);
    }

    /**
     * @param {number} mapId
     * @param {number} vwid
     * @param {number} wallType
     * @param {[number,number,number,number]} rect
     * @returns {Promise<number>}
     */
    async addVirtualWallRect(mapId, vwid, wallType, rect) {
        const [x1, y1, x2, y2] = rect;
        return await this.addVirtualWallPoints(mapId, vwid, wallType, [[x1, y1], [x1, y2], [x2, y2], [x2, y1]]);
    }

    /**
     * @param {number} mapId
     * @param {number} vwid
     * @param {number} wallType
     * @param {Array<[number,number]>} dots
     * @returns {Promise<number>}
     */
    async addVirtualWallPoints(mapId, vwid, wallType, dots) {
        const wall = {
            vwid: vwid,
            type: wallType,
            dots: dots.map(dot => [Number(dot[0]), Number(dot[1])])
        };
        const response = await this.callVirtualWall({
            type: VIRTUAL_WALL_MANIPULATE_TYPE.ADD,
            mapId: mapId,
            vwid: 0xffffffff,
            walls: [wall]
        });

        return response.result;
    }

    /**
     * @param {number} mapId
     * @param {number} vwid
     * @returns {Promise<number>}
     */
    async deleteVirtualWall(mapId, vwid) {
        const response = await this.callVirtualWall({
            type: VIRTUAL_WALL_MANIPULATE_TYPE.DELETE,
            mapId: mapId,
            vwid: vwid,
            walls: []
        });

        return response.result;
    }

    /**
     * @param {number} mapId
     * @param {number} [scanMaxId]
     * @returns {Promise<Array<{vwid:number,type:number,dots:Array<[number,number]>}>>}
     */
    async getNoMopZones(mapId, scanMaxId = -1) {
        const walls = await this.getVirtualWalls(mapId, scanMaxId);

        return walls.filter(wall => wall.type === VIRTUAL_WALL_TYPE.CARPET);
    }

    /**
     * @param {number} mapId
     * @param {number} vwid
     * @param {[number,number,number,number]} rect
     * @returns {Promise<number>}
     */
    async addNoMopZone(mapId, vwid, rect) {
        return await this.addVirtualWallRect(mapId, vwid, VIRTUAL_WALL_TYPE.CARPET, rect);
    }

    /**
     * @param {{type:number,mapId:number,vwid:number,walls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}} request
     * @returns {Promise<{result:number,mapid:number,vwalls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}>}
     */
    async callVirtualWall(request) {
        const body = await this.virtualWallClient.call(serializeVirtualWallRequest(request));

        return parseVirtualWallResponse(body);
    }
}

/**
 * @param {{type:number,mapId:number,vwid:number,walls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}} options
 * @returns {Buffer}
 */
function serializeVirtualWallRequest(options) {
    const chunks = [];
    chunks.push(Buffer.from([options.type & 0xff]));
    chunks.push(encodeUInt32(options.mapId));
    chunks.push(encodeUInt32(options.vwid >>> 0));
    const walls = options.walls ?? [];
    chunks.push(encodeUInt32(walls.length));
    for (const wall of walls) {
        chunks.push(encodeUInt32(wall.vwid >>> 0));
        chunks.push(Buffer.from([wall.type & 0xff]));
        chunks.push(encodeUInt32(wall.dots.length));
        for (const [x, y] of wall.dots) {
            chunks.push(encodeFloat32(Number(x)));
            chunks.push(encodeFloat32(Number(y)));
        }
    }

    return Buffer.concat(chunks);
}

/**
 * @param {Buffer} body
 * @returns {{result:number,mapid:number,vwalls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}}
 */
function parseVirtualWallResponse(body) {
    const cursor = new BinaryCursor(body);
    const result = cursor.readUInt8();
    const mapid = cursor.readUInt32LE();
    const count = cursor.readUInt32LE();
    const vwalls = [];
    for (let i = 0; i < count; i++) {
        const vwid = cursor.readUInt32LE();
        const type = cursor.readUInt8();
        const dotsCount = cursor.readUInt32LE();
        const dots = [];
        for (let j = 0; j < dotsCount; j++) {
            dots.push([cursor.readFloatLE(), cursor.readFloatLE()]);
        }
        vwalls.push({
            vwid: vwid,
            type: type,
            dots: dots
        });
    }

    return {
        result: result,
        mapid: mapid,
        vwalls: vwalls
    };
}

module.exports = EcovacsVirtualWallService;
