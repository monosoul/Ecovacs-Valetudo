"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const Logger = require("../../../../Logger");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {encodeUInt32, encodeFloat32} = require("../protocol/encoding");
const {labelNameFromId} = require("../../RoomLabels");

const SPOT_AREA_ROOM_PREFS_TYPE = 4;
const SPOT_AREA_SEQUENCE_TYPE = 5;

const SERVICE = {
    md5: "1f749a4ee1df1b94d34bf35bc2c05e3b",
    name: "/map/ManipulateSpotArea"
};

class EcovacsSpotAreaService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.spotAreaClient = new PersistentServiceClient({
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
        await this.spotAreaClient.shutdown();
    }

    /**
     * @param {number} mapId
     * @returns {Promise<{header:{result:number,mapid:number,areasId:number,areaCount:number},rooms:Array<any>}>}
     */
    async getRooms(mapId) {
        const body = await this.callSpotAreaGetWithFallback(mapId);
        const parsed = parseSpotAreaGetResponse(body);

        return {
            header: parsed.header,
            rooms: parsed.rooms.map(room => ({
                index: room.areaid,
                polygon: room.polygon,
                label_id: room.labelId,
                label_name: labelNameFromId(room.labelId),
                preference_suction: room.suctionPower,
                preference_water: room.waterLevel,
                preference_times: room.cleaningTimes,
                preference_sequence: room.sequencePosition,
                preference_connections: room.connections
            }))
        };
    }

    /**
     * @param {number} mapId
     * @param {number} roomId
     * @param {number} labelId
     * @returns {Promise<{result:number,mapid:number,areasId:number,areaCount:number}>}
     */
    async setRoomLabel(mapId, roomId, labelId) {
        const request = buildRoomsSetLabelRequest(mapId, roomId, labelId);
        Logger.debug(
            `setRoomLabel: mapId=${mapId} roomId=${roomId} labelId=${labelId} ` +
            `requestHex=${request.toString("hex")}`
        );
        const body = await this.spotAreaClient.call(request);
        Logger.debug(`setRoomLabel: responseHex=${body.toString("hex")}`);

        return parseRoomsHeaderOnly(body);
    }

    /**
     * @param {number} mapId
     * @param {Array<number>} roomIds
     * @returns {Promise<{result:number,mapid:number,areasId:number,areaCount:number}>}
     */
    async mergeRooms(mapId, roomIds) {
        const request = serializeSpotAreaRequest({
            type: 2,
            mapId: mapId,
            areaIds: roomIds
        });
        const body = await this.spotAreaClient.call(request);

        return parseRoomsHeaderOnly(body);
    }

    /**
     * @param {number} mapId
     * @param {number} roomId
     * @param {[number,number,number,number]} line
     * @returns {Promise<{result:number,mapid:number,areasId:number,areaCount:number}>}
     */
    async splitRoom(mapId, roomId, line) {
        const [x1, y1, x2, y2] = line;
        const request = serializeSpotAreaRequest({
            type: 3,
            mapId: mapId,
            areaIds: [roomId],
            splitLine: [[x1, y1], [x2, y2]]
        });
        const body = await this.spotAreaClient.call(request);

        return parseRoomsHeaderOnly(body);
    }

    /**
     * @param {number} mapId
     * @returns {Promise<any>}
     */
    async getRoomCleaningPreferences(mapId) {
        const body = await this.callSpotAreaGetWithFallback(mapId);
        const parsed = parseSpotAreaGetResponse(body);

        return {
            header: parsed.header,
            rooms: parsed.rooms.map(room => ({
                index: room.areaid,
                label_id: room.labelId,
                decoded: {
                    suction_power: room.suctionPower,
                    water_level: room.waterLevel,
                    cleaning_times: room.cleaningTimes,
                    sequence_position: room.sequencePosition,
                    connections: room.connections
                }
            }))
        };
    }

    /**
     * @param {number} mapId
     * @param {number} roomId
     * @param {number} cleaningTimes
     * @param {number} waterLevel
     * @param {number} suctionPower
     * @returns {Promise<any>}
     */
    async setRoomCleaningPreferences(mapId, roomId, cleaningTimes, waterLevel, suctionPower) {
        const request = buildRoomPreferencesRequest(mapId, roomId, cleaningTimes, waterLevel, suctionPower);
        const body = await this.spotAreaClient.call(request);

        return {
            header: parseRoomsHeaderOnly(body)
        };
    }

    /**
     * Set room cleaning sequence/order.
     *
     * @param {number} mapId
     * @param {Array<{roomIndex:number, position:number}>} sequence
     * @returns {Promise<{header:any}>}
     */
    async setRoomCleaningSequence(mapId, sequence) {
        const request = buildRoomSequenceRequest(mapId, sequence);
        const body = await this.spotAreaClient.call(request);

        return {
            header: parseRoomsHeaderOnly(body)
        };
    }

    /**
     * Some firmware variants reject full GET_SPOTAREAS request bodies and only accept
     * minimal 5-byte payload: <u8 type=GET><u32 mapid>.
     *
     * @param {number} mapId
     * @returns {Promise<Buffer>}
     */
    async callSpotAreaGetWithFallback(mapId) {
        try {
            return await this.spotAreaClient.call(serializeSpotAreaRequest({
                type: 0,
                mapId: mapId
            }));
        } catch (error) {
            const message = String(error?.message ?? "").toLowerCase();
            if (!message.includes("buffer overrun") && !message.includes("broken pipe")) {
                throw error;
            }

            return await this.spotAreaClient.call(buildSpotAreaMinimalGetRequest(mapId));
        }
    }
}

/**
 * @param {Buffer} body
 * @returns {{result:number,mapid:number,areasId:number,areaCount:number}}
 */
function parseRoomsHeaderOnly(body) {
    const cursor = new BinaryCursor(body);

    return {
        result: cursor.readUInt8(),
        mapid: cursor.readUInt32LE(),
        areasId: cursor.readUInt32LE(),
        areaCount: cursor.readUInt32LE()
    };
}

/**
 * Deterministic parser for the SpotArea GET response.
 *
 * Wire format per room:
 *   u32 areaid, u32 nameLen, u8[nameLen] name, u8 labelId,
 *   u32 pointCount, (f32 x, f32 y)[pointCount],
 *   u32 connCount, u32[connCount] connections,
 *   u32 suctionPower, u32 waterLevel, u32 cleaningTimes, u8 sequencePosition
 *
 * @param {Buffer} body
 * @returns {{header:{result:number,mapid:number,areasId:number,areaCount:number},rooms:Array<{areaid:number,name:string,labelId:number,polygon:Array<[number,number]>,connections:Array<number>,suctionPower:number,waterLevel:number,cleaningTimes:number,sequencePosition:number}>}}
 */
function parseSpotAreaGetResponse(body) {
    const cursor = new BinaryCursor(body);

    const header = {
        result: cursor.readUInt8(),
        mapid: cursor.readUInt32LE(),
        areasId: cursor.readUInt32LE(),
        areaCount: cursor.readUInt32LE()
    };

    const rooms = [];
    for (let i = 0; i < header.areaCount; i++) {
        const areaid = cursor.readUInt32LE();

        const nameLen = cursor.readUInt32LE();
        const name = nameLen > 0 ? cursor.readBuffer(nameLen).toString("utf8") : "";

        const labelId = cursor.readUInt8();

        const pointCount = cursor.readUInt32LE();
        const polygon = [];
        for (let j = 0; j < pointCount; j++) {
            polygon.push([cursor.readFloatLE(), cursor.readFloatLE()]);
        }

        const connCount = cursor.readUInt32LE();
        const connections = [];
        for (let j = 0; j < connCount; j++) {
            connections.push(cursor.readUInt32LE());
        }

        rooms.push({
            areaid: areaid,
            name: name,
            labelId: labelId,
            polygon: polygon,
            connections: connections,
            suctionPower: cursor.readUInt32LE(),
            waterLevel: cursor.readUInt32LE(),
            cleaningTimes: cursor.readUInt32LE(),
            sequencePosition: cursor.readUInt8()
        });
    }

    return {
        header: header,
        rooms: rooms
    };
}

/**
 * @param {{type:number,mapId:number,areaIds?:Array<number>,splitLine?:Array<[number,number]>}} options
 * @returns {Buffer}
 */
function serializeSpotAreaRequest(options) {
    const chunks = [];
    chunks.push(Buffer.from([options.type & 0xff]));
    chunks.push(encodeUInt32(options.mapId));

    const areaIds = options.areaIds ?? [];
    chunks.push(encodeUInt32(areaIds.length));
    if (areaIds.length > 0) {
        const areaBuf = Buffer.alloc(areaIds.length * 4);
        areaIds.forEach((id, i) => areaBuf.writeUInt32LE(id >>> 0, i * 4));
        chunks.push(areaBuf);
    }

    const splitLine = options.splitLine ?? [];
    chunks.push(encodeUInt32(splitLine.length));
    for (const [x, y] of splitLine) {
        chunks.push(encodeFloat32(Number(x)));
        chunks.push(encodeFloat32(Number(y)));
    }

    chunks.push(encodeUInt32(0)); // areas[]

    return Buffer.concat(chunks);
}

/**
 * @param {number} mapId
 * @returns {Buffer}
 */
function buildSpotAreaMinimalGetRequest(mapId) {
    const out = Buffer.alloc(5);
    out.writeUInt8(0, 0);
    out.writeUInt32LE(mapId >>> 0, 1);

    return out;
}

/**
 * @param {number} mapId
 * @param {number} roomId
 * @param {number} labelId
 * @returns {Buffer}
 */
function buildRoomsSetLabelRequest(mapId, roomId, labelId) {
    const body = Buffer.alloc(47, 0);
    body.writeUInt8(1, 0);
    body.writeUInt32LE(mapId >>> 0, 1);
    body.writeUInt8(1, 13);
    body.writeUInt32LE(roomId >>> 0, 17);
    body.writeUInt32LE(labelId >>> 0, 25);

    return body;
}

/**
 * @param {number} type
 * @param {number} mapId
 * @param {number} roomCount
 * @returns {Buffer}
 */
function allocSpotAreaRoomBlockRequest(type, mapId, roomCount) {
    const body = Buffer.alloc(17 + roomCount * 30);
    body.writeUInt8(type, 0);
    body.writeUInt32LE(mapId >>> 0, 1);
    // bytes 5..12: zeros (padding)
    body.writeUInt32LE(roomCount, 13);

    return body;
}

/**
 * @param {number} mapId
 * @param {number} roomId
 * @param {number} cleaningTimes
 * @param {number} waterLevel
 * @param {number} suctionPower
 * @returns {Buffer}
 */
function buildRoomPreferencesRequest(mapId, roomId, cleaningTimes, waterLevel, suctionPower) {
    const body = allocSpotAreaRoomBlockRequest(SPOT_AREA_ROOM_PREFS_TYPE, mapId, 1);
    body.writeUInt8(roomId & 0xFF, 17);
    // bytes 18..33: zeros (padding)
    body.writeUInt32LE(suctionPower >>> 0, 34);
    body.writeUInt32LE(waterLevel >>> 0, 38);
    body.writeUInt32LE(cleaningTimes >>> 0, 42);
    // byte 46: zero (padding)

    return body;
}

/**
 * @param {number} mapId
 * @param {Array<{roomIndex:number, position:number}>} sequence
 * @returns {Buffer}
 */
function buildRoomSequenceRequest(mapId, sequence) {
    const body = allocSpotAreaRoomBlockRequest(SPOT_AREA_SEQUENCE_TYPE, mapId, sequence.length);
    for (let i = 0; i < sequence.length; i++) {
        const offset = 17 + i * 30;
        body.writeUInt8(sequence[i].roomIndex & 0xFF, offset);
        body.writeUInt8(sequence[i].position & 0xFF, offset + 29);
    }

    return body;
}

module.exports = EcovacsSpotAreaService;
