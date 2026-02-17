"use strict";

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

        const header = parseRoomsHeaderOnly(body);
        const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);
        const decodedPrefs = extractRoomPreferences(body, rooms);
        const preferencesByIndex = {};
        for (const pref of decodedPrefs) {
            preferencesByIndex[pref.index] = pref;
        }

        return {
            header: header,
            rooms: rooms.map(room => {
                const decoded = preferencesByIndex[room.index]?.decoded;

                return {
                    index: room.index,
                    offset: room.offset,
                    point_count: room.pointCount,
                    bbox: room.bbox,
                    polygon: room.polygon,
                    metadata_prefix_len: room.metadataPrefixLen,
                    label_id: room.labelId,
                    label_name: labelNameFromId(room.labelId),
                    preference_suction: decoded?.suction_power,
                    preference_water: decoded?.water_level,
                    preference_times: decoded?.cleaning_times,
                    preference_sequence: decoded?.sequence_position ?? 0,
                    preference_connections: decoded?.connections ?? []
                };
            })
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

        return decodeRoomPreferencesFromGetResponse(body);
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
    if (body.length < 13) {
        throw new Error("SpotArea response too short for header");
    }

    return {
        result: body.readUInt8(0),
        mapid: body.readUInt32LE(1),
        areasId: body.readUInt32LE(5),
        areaCount: body.readUInt32LE(9)
    };
}

/**
 * @param {Buffer} body
 * @param {number} areaCount
 * @returns {Array<{index:number,offset:number,pointCount:number,bbox:Array<number>,polygon:Array<[number,number]>,metadataPrefixLen:number,labelId:number}>}
 */
function extractRoomPolygonsDeterministic(body, areaCount) {
    const rooms = [];
    let cursor = 13;

    for (let idx = 0; idx < areaCount; idx++) {
        let found = null;
        for (let off = cursor + 8; off <= body.length - 4; off++) {
            const z1 = body.readUInt32LE(off - 8);
            const z2 = body.readUInt32LE(off - 4);
            if (z1 !== 0 || (z2 & 0x00FFFFFF) !== 0) {
                continue;
            }
            const pointCount = body.readUInt32LE(off);
            if (pointCount < 3 || pointCount > 256) {
                continue;
            }
            const end = off + 4 + pointCount * 8;
            if (end > body.length) {
                continue;
            }

            let plausible = 0;
            const probe = Math.min(pointCount, 10);
            for (let i = 0; i < probe; i++) {
                const x = body.readFloatLE(off + 4 + i * 8);
                const y = body.readFloatLE(off + 8 + i * 8);
                if (looksLikeCoord(x) && looksLikeCoord(y)) {
                    plausible++;
                }
            }
            if (plausible < Math.max(2, Math.min(pointCount, 6) - 2)) {
                continue;
            }

            found = {off: off, end: end, pointCount: pointCount};
            break;
        }
        if (!found) {
            throw new Error(`Room block ${idx} not found from offset ${cursor}`);
        }

        const areaidOffset = found.off - 9;
        if (areaidOffset < 0) {
            throw new Error(`Room block ${idx}: areaid offset ${areaidOffset} is before buffer start`);
        }
        const areaid = body.readUInt32LE(areaidOffset);

        const metadata = body.subarray(cursor, found.off);
        const labelId = metadata.length > 0 ? metadata[metadata.length - 1] : 0;
        const polygon = [];
        for (let i = 0; i < found.pointCount; i++) {
            polygon.push([
                body.readFloatLE(found.off + 4 + i * 8),
                body.readFloatLE(found.off + 8 + i * 8)
            ]);
        }
        const xs = polygon.map(point => point[0]);
        const ys = polygon.map(point => point[1]);

        rooms.push({
            index: areaid,
            offset: found.off,
            pointCount: found.pointCount,
            bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
            polygon: polygon,
            metadataPrefixLen: found.off - cursor,
            labelId: labelId
        });
        cursor = found.end;
    }

    return rooms;
}

/**
 * Extract room preferences from a post-polygon gap or tail buffer.
 *
 * @param {Buffer} gapData
 * @returns {{suction_power:number, water_level:number, cleaning_times:number, sequence_position:number, connections:Array<number>}|null}
 */
function extractPrefsFromGap(gapData) {
    if (gapData.length < 4) {
        return null;
    }
    const connCount = gapData.readUInt32LE(0);
    if (connCount > 64) {
        return null;
    }
    const prefOffset = 4 + connCount * 4;
    if (prefOffset + 12 > gapData.length) {
        return null;
    }
    const suction = gapData.readUInt32LE(prefOffset);
    const water = gapData.readUInt32LE(prefOffset + 4);
    const times = gapData.readUInt32LE(prefOffset + 8);
    const seqOffset = prefOffset + 12;
    const sequencePosition = seqOffset < gapData.length ? gapData.readUInt8(seqOffset) : 0;
    const connections = [];
    for (let i = 0; i < connCount; i++) {
        connections.push(gapData.readUInt32LE(4 + i * 4));
    }

    return {
        suction_power: suction,
        water_level: water,
        cleaning_times: times,
        sequence_position: sequencePosition,
        connections: connections
    };
}

/**
 * @param {Buffer} body
 * @returns {{header:any, rooms:Array<{index:number, label_id:number, decoded:{suction_power:number,water_level:number,cleaning_times:number,connections:Array<number>}|null}>}}
 */
function decodeRoomPreferencesFromGetResponse(body) {
    const header = parseRoomsHeaderOnly(body);
    const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);

    return {
        header: header,
        rooms: extractRoomPreferences(body, rooms)
    };
}

/**
 * Extract per-room cleaning preferences from already-parsed rooms.
 *
 * @param {Buffer} body
 * @param {Array<{index:number,offset:number,pointCount:number,metadataPrefixLen:number,labelId:number}>} rooms
 * @returns {Array<{index:number, label_id:number, decoded:{suction_power:number,water_level:number,cleaning_times:number,sequence_position:number,connections:Array<number>}|null}>}
 */
function extractRoomPreferences(body, rooms) {
    const rawMetas = rooms.map(room => {
        const metaStart = room.offset - room.metadataPrefixLen;
        return body.subarray(metaStart, room.offset);
    });

    let tailBytes = Buffer.alloc(0);
    if (rooms.length > 0) {
        const last = rooms[rooms.length - 1];
        const tailStart = last.offset + 4 + last.pointCount * 8;
        tailBytes = body.subarray(tailStart);
    }

    return rooms.map((room, pos) => {
        const gap = (pos + 1 < rawMetas.length) ?
            rawMetas[pos + 1] :
            tailBytes;

        return {
            index: room.index,
            label_id: room.labelId,
            decoded: extractPrefsFromGap(gap)
        };
    });
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

/**
 * @param {number} value
 * @returns {boolean}
 */
function looksLikeCoord(value) {
    return Number.isFinite(value) && Math.abs(value) <= 20_000;
}

module.exports = EcovacsSpotAreaService;
