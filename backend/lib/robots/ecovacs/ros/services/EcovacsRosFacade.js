"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const Logger = require("../../../../Logger");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const PredictionPoseSubscriber = require("../core/PredictionPoseSubscriber");
const RosMasterXmlRpcClient = require("../core/RosMasterXmlRpcClient");
const {
    TopicStateSubscriber,
    decodePowerBattery,
    decodePowerChargeState,
    decodeTaskWorkState
} = require("../core/TopicStateSubscriber");
const {labelNameFromId} = require("../../RoomLabels");

const SPOT_AREA_ROOM_PREFS_TYPE = 4;
const SPOT_AREA_SEQUENCE_TYPE = 5;

const SERVICES = {
    map: {
        md5: "17d5f22724c41493b1778b9d79687330",
        candidates: ["/map/GetCurrentCompressMap", "/map/getCurrentCompressMap", "/map/get_current_compress_map"]
    },
    spotArea: {
        md5: "1f749a4ee1df1b94d34bf35bc2c05e3b",
        candidates: ["/map/ManipulateSpotArea", "/map/manipulateSpotArea", "/map/manipulate_spot_area"]
    },
    charger: {
        md5: "9cde7b036866c35b41f8cc3957bbf01d",
        candidates: ["/map/ManipulateCharger", "/map/manipulateCharger", "/map/manipulate_charger"]
    },
    trace: {
        md5: "9760daeffedcd8659af2b5cda59a76c1",
        candidates: ["/map/ManipulateTrace", "/map/manipulateTrace", "/map/manipulate_trace"]
    },
    virtualWall: {
        md5: "5ac048cd1de2f92de83f97bf5aac52e9",
        candidates: ["/map/ManipulateVirtualWall", "/map/manipulateVirtualWall", "/map/manipulate_virtual_wall"]
    },
    work: {
        md5: "07877d0b6f69402fce5b6b91983c66f7",
        candidates: ["/task/WorkManage", "/task/workManage", "/task/work_manage"]
    },
    setting: {
        md5: "9b750807a5def60e40619d50b06ae034",
        candidates: ["/setting/SettingManage", "/setting/settingManage", "/setting/setting_manage"]
    },
    lifespan: {
        md5: "35c020f6d3af5b57369fe7f26779c5d8",
        candidates: ["/lifespan/lifespan", "/lifespan/lifespansrv"]
    }
};

const WORK_MANAGE_TYPE = {
    START: 0,
    STOP: 1,
    PAUSE: 2,
    RESUME: 3
};

const WORK_TYPE = {
    AUTO_CLEAN: 0,
    AREA_CLEAN: 1,
    CUSTOM_CLEAN: 2,
    RETURN: 5,
    IDLE: 7,
    REMOTE_CONTROL: 9,
    AUTO_COLLECT_DIRT: 13
};

const SETTING_MANAGE_TYPE = {
    GET: 0,
    SET: 1
};

const LIFESPAN_MANAGE_TYPE = {
    GET: 0,
    RESET: 1
};

const LIFESPAN_PART = {
    MAIN_BRUSH: 0,
    SIDE_BRUSH: 1,
    HEPA: 2,
    ALL: 3
};

const SETTING_TYPE = {
    AUTO_COLLECT: 13,
    WATER_LEVEL: 6,
    FAN_LEVEL: 7,
    ROOM_PREFERENCES: 14,
    CLEANING_TIMES: 15,
    SUCTION_BOOST_ON_CARPET: 8
};

const VIRTUAL_WALL_TYPE = {
    NORMAL: 0,
    CARPET: 1
};

const VIRTUAL_WALL_MANIPULATE_TYPE = {
    ADD: 0,
    DELETE: 1,
    GET_ALL: 4,
    GET_BY_ID: 5
};

class EcovacsRosFacade {
    /**
     * @param {object} options
     * @param {string} [options.masterUri]
     * @param {string} [options.callerId]
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options = {}) {
        const masterUri = options.masterUri ?? process.env.ROS_MASTER_URI ?? "http://127.0.0.1:11311";
        const callerId = options.callerId ?? process.env.ROS_CALLER_ID ?? "/ROSNODE";

        const debug = options.debug ?? false;
        this.debug = debug;
        this.masterClient = new RosMasterXmlRpcClient({
            masterUri: masterUri,
            timeoutMs: options.connectTimeoutMs ?? 4000
        });
        this.callerId = callerId;

        /**
         * @param {keyof SERVICES} key
         * @param {{persistent?:boolean}} [extra]
         */
        const makeClient = (key, extra) => {
            return new PersistentServiceClient({
                masterClient: this.masterClient,
                callerId: this.callerId,
                serviceCandidates: SERVICES[key].candidates,
                serviceMd5: SERVICES[key].md5,
                connectTimeoutMs: options.connectTimeoutMs,
                callTimeoutMs: options.callTimeoutMs,
                debug: debug,
                ...extra
            });
        };

        this.mapClient = makeClient("map");
        this.spotAreaClient = makeClient("spotArea");
        this.chargerClient = makeClient("charger");
        this.traceClient = makeClient("trace");
        this.virtualWallClient = makeClient("virtualWall", {persistent: false});
        this.workClient = makeClient("work", {persistent: false});
        this.settingClient = makeClient("setting", {persistent: false});
        this.lifespanClient = makeClient("lifespan", {persistent: false});

        this.poseSubscriber = new PredictionPoseSubscriber({
            masterClient: this.masterClient,
            callerId: this.callerId,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn
        });
        this.batterySubscriber = new TopicStateSubscriber({
            masterClient: this.masterClient,
            callerId: this.callerId,
            topic: "/power/Battery",
            type: "power/Battery",
            md5: "1f868bac590fa9e653b61dc342b25421",
            decoder: decodePowerBattery,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn
        });
        this.chargeStateSubscriber = new TopicStateSubscriber({
            masterClient: this.masterClient,
            callerId: this.callerId,
            topic: "/power/ChargeState",
            type: "power/ChargeState",
            md5: "3f40efefe99d0b54d25afc2ed5523fc0",
            decoder: decodePowerChargeState,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn
        });
        this.workStateSubscriber = new TopicStateSubscriber({
            masterClient: this.masterClient,
            callerId: this.callerId,
            topic: "/task/WorkState",
            type: "task/WorkState",
            md5: "85234983b5d2c6828f53442a64052ae3",
            decoder: decodeTaskWorkState,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn
        });
    }

    async startup() {
        await this.poseSubscriber.start();
        await this.batterySubscriber.start();
        await this.chargeStateSubscriber.start();
        await this.workStateSubscriber.start();
    }

    async shutdown() {
        await this.poseSubscriber.shutdown();
        await this.batterySubscriber.shutdown();
        await this.chargeStateSubscriber.shutdown();
        await this.workStateSubscriber.shutdown();
        await this.mapClient.shutdown();
        await this.spotAreaClient.shutdown();
        await this.chargerClient.shutdown();
        await this.traceClient.shutdown();
        await this.virtualWallClient.shutdown();
        await this.workClient.shutdown();
        await this.settingClient.shutdown();
        await this.lifespanClient.shutdown();
    }

    /**
     * @param {number} staleMs
     * @returns {{battery:{battery:number,isLowVoltageToPowerOff:number}|null,chargeState:{isOnCharger:number,chargeState:number}|null}}
     */
    getPowerState(staleMs) {
        return {
            battery: this.batterySubscriber.getLatestValue(staleMs),
            chargeState: this.chargeStateSubscriber.getLatestValue(staleMs)
        };
    }

    /**
     * @param {number} staleMs
     * @returns {{battery:{battery:number,isLowVoltageToPowerOff:number}|null,chargeState:{isOnCharger:number,chargeState:number}|null,workState:{worktype:number,state:number,workcause:number}|null}}
     */
    getRuntimeState(staleMs) {
        return {
            battery: this.batterySubscriber.getLatestValue(staleMs),
            chargeState: this.chargeStateSubscriber.getLatestValue(staleMs),
            workState: this.workStateSubscriber.getLatestValue(staleMs)
        };
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

    /**
     * @param {number} mapId
     * @returns {Promise<{header:{result:number,mapid:number,areasId:number,areaCount:number},rooms:Array<any>}>}
     */
    async getRooms(mapId) {
        const body = await this.callSpotAreaGetWithFallback(mapId);

        const header = parseRoomsHeaderOnly(body);
        const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);
        const decodedPrefs = decodeRoomPreferencesFromGetResponse(body);
        const preferencesByIndex = {};
        for (const pref of decodedPrefs.rooms) {
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
        const body = await this.spotAreaClient.call(request);

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
     * @param {number} mapId
     * @param {number} stalePoseMs
     * @returns {Promise<any>}
     */
    async getPositions(mapId, stalePoseMs) {
        /** @type {{x:number,y:number,theta:number,source:string,docktype:number,result:number,valid?:number,error?:string}} */
        let chargerPose;
        try {
            const chargerReq = Buffer.alloc(5);
            chargerReq.writeUInt8(0, 0);
            chargerReq.writeUInt32LE(mapId >>> 0, 1);
            const chargerBody = await this.chargerClient.call(chargerReq);
            chargerPose = parseChargerResponse(chargerBody);
        } catch (e) {
            chargerPose = {
                source: "service:/map/ManipulateCharger",
                valid: 0,
                error: `charger pose unavailable: ${String(e?.message ?? e)}`,
                x: 0,
                y: 0,
                theta: 0,
                docktype: 0,
                result: 1
            };
        }
        const robotPose = this.poseSubscriber.getLatestPose(stalePoseMs);

        return {
            robot: {
                topic: "topic:/prediction/*",
                type: "prediction/Pose|UpdatePose|PredictPose",
                pose: robotPose ?? {
                    source: "topic:/prediction/*",
                    valid: 0,
                    error: "no fresh prediction pose available"
                }
            },
            charger: {
                topic: "service:/map/ManipulateCharger",
                type: "map/ManipulateCharger",
                pose: chargerPose
            }
        };
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
     * @returns {Promise<number>}
     */
    async pauseCleaning() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.PAUSE,
                workType: WORK_TYPE.AUTO_CLEAN
            })
        );
    }

    /**
     * @returns {Promise<number>}
     */
    async resumeCleaning() {
        return await this.callWorkManage(
            serializeWorkManageRequest({
                manageType: WORK_MANAGE_TYPE.RESUME,
                workType: WORK_TYPE.AUTO_CLEAN
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
     * @returns {Promise<"on"|"off">}
     */
    async getSuctionBoostOnCarpet() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.customSettingVal === 1 ? "on" : "off";
    }

    /**
     * @returns {Promise<{mode:number,isSilent:number}>}
     */
    async getFanMode() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.FAN_LEVEL
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return {
            mode: parsed.fanMode,
            isSilent: parsed.fanIsSilent
        };
    }

    /**
     * @returns {Promise<number>}
     */
    async getWaterLevel() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.WATER_LEVEL
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.waterLevel;
    }

    /**
     * @returns {Promise<"on"|"off">}
     */
    async getRoomPreferencesEnabled() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.ROOM_PREFERENCES
        });
        const body = await this.settingClient.call(request);
        const value = decodeSettingTailValue(body, SETTING_TYPE.ROOM_PREFERENCES);
        if (!Number.isInteger(value)) {
            throw new Error("ROOM_PREFERENCES value not found in SettingManage response");
        }

        return value === 1 ? "on" : "off";
    }

    /**
     * @returns {Promise<number>}
     */
    async getCleaningTimesPasses() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.CLEANING_TIMES
        });
        const body = await this.settingClient.call(request);
        const value = decodeSettingTailValue(body, SETTING_TYPE.CLEANING_TIMES);
        if (!Number.isInteger(value)) {
            throw new Error("CLEANING_TIMES value not found in SettingManage response");
        }

        return value;
    }

    /**
     * @returns {Promise<"on"|"off">}
     */
    async getAutoCollectEnabled() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.AUTO_COLLECT
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.autoCollect === 1 ? "on" : "off";
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setSuctionBoostOnCarpet(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET,
            customSettingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET,
            customSettingVal: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @returns {Promise<number>}
     */
    async getFanLevel() {
        const fan = await this.getFanMode();

        return fan.mode;
    }

    /**
     * @param {number} level
     * @returns {Promise<number>}
     */
    async setFanLevel(level) {
        return await this.setFanMode(level, 0);
    }

    /**
     * @param {number} level
     * @param {number} [isSilent]
     * @returns {Promise<number>}
     */
    async setFanMode(level, isSilent = 0) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.FAN_LEVEL,
            fanMode: level,
            fanIsSilent: isSilent
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {number} level
     * @returns {Promise<number>}
     */
    async setWaterLevel(level) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.WATER_LEVEL,
            waterLevel: level
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setRoomPreferencesEnabled(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.ROOM_PREFERENCES,
            autoCollectVal: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setAutoCollectEnabled(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.AUTO_COLLECT,
            autoCollectVal: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {number} passes
     * @returns {Promise<number>}
     */
    async setCleaningTimesPasses(passes) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.CLEANING_TIMES,
            autoCollectVal: passes
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
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

    /**
     * @param {{type:number,mapId:number,vwid:number,walls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}} request
     * @returns {Promise<{result:number,mapid:number,vwalls:Array<{vwid:number,type:number,dots:Array<[number,number]>}>}>}
     */
    async callVirtualWall(request) {
        const body = await this.virtualWallClient.call(serializeVirtualWallRequest(request));

        return parseVirtualWallResponse(body);
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
            index: idx,
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
 * Capture-validated structure (pcap byte-diff analysis):
 *   [connections_count: u32 LE]
 *   [connections: u32 LE * connections_count]   -- adjacent room indices
 *   [suction_power: u32 LE]   -- 0=standard, 1=strong, 2=max, 1000=quiet
 *   [water_level: u32 LE]     -- 0=low, 1=medium, 2=high, 3=ultra_high
 *   [cleaning_times: u32 LE]  -- 1 or 2
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
    // Sequence position is a u8 immediately after cleaning_times
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
 * Decode per-room cleaning preferences from GET_SPOTAREAS response body.
 *
 * Key insight: Room N's preferences are stored in the gap AFTER room N's polygon,
 * not in the metadata before it. For the last room, preferences are in the tail.
 *
 * @param {Buffer} body
 * @returns {{header:any, rooms:Array<{index:number, label_id:number, decoded:{suction_power:number,water_level:number,cleaning_times:number,connections:Array<number>}|null}>}}
 */
function decodeRoomPreferencesFromGetResponse(body) {
    const header = parseRoomsHeaderOnly(body);
    const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);

    // Collect raw metadata gaps (bytes before each polygon) and the tail
    const rawMetas = rooms.map(room => {
        const metaStart = room.offset - room.metadataPrefixLen;
        return body.subarray(metaStart, room.offset);
    });

    // Tail: everything after the last room's polygon
    let tailBytes = Buffer.alloc(0);
    if (rooms.length > 0) {
        const last = rooms[rooms.length - 1];
        const tailStart = last.offset + 4 + last.pointCount * 8;
        tailBytes = body.subarray(tailStart);
    }

    const decodedRooms = rooms.map(room => {
        // Room N's prefs are in rawMetas[N+1] (next room's gap) or tail (last room)
        const gap = (room.index + 1 < rawMetas.length) ?
            rawMetas[room.index + 1] :
            tailBytes;

        return {
            index: room.index,
            label_id: room.labelId,
            decoded: extractPrefsFromGap(gap)
        };
    });

    return {
        header: header,
        rooms: decodedRooms
    };
}

/**
 * @param {Buffer} body
 * @returns {{x:number,y:number,theta:number,source:string,docktype:number,result:number}}
 */
function parseChargerResponse(body) {
    const cursor = new BinaryCursor(body);
    const isPoseValid = cursor.readUInt8();
    const docktype = cursor.readUInt8();
    const x = cursor.readFloatLE();
    const y = cursor.readFloatLE();
    const theta = cursor.readFloatLE();
    const result = cursor.readUInt8();
    if (isPoseValid !== 1) {
        throw new Error("charger pose is not valid");
    }

    return {
        x: x,
        y: y,
        theta: theta,
        source: "manipulate_charger_service",
        docktype: docktype,
        result: result
    };
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

/**
 * @param {Buffer} body
 * @returns {{response:number,settingType:number,customSettingVal:number,waterLevel:number,fanMode:number,fanIsSilent:number,autoCollect:number}}
 */
function parseSettingManageResponse(body) {
    const cursor = new BinaryCursor(body);
    const response = cursor.readUInt8();
    const settingType = cursor.readUInt8();
    const customType = cursor.readUInt8();
    const customSettingVal = cursor.readUInt8();
    cursor.readBuffer(16); // blocktime + mop mode
    const waterLevel = cursor.readUInt8(); // waterLevel.level
    const fanMode = cursor.readUInt8(); // fanMode.mode
    const fanIsSilent = cursor.readUInt8(); // fanMode.isSilent
    cursor.readUInt8(); // aiSetting.isOn
    const aiSettingValsLength = cursor.readUInt32LE();
    cursor.readBuffer(aiSettingValsLength);
    cursor.readBuffer(8); // mop change + notice time
    cursor.readUInt8(); // StructLightOnOff
    const autoCollect = cursor.readUInt8();

    return {
        response: response,
        settingType: settingType,
        customType: customType,
        customSettingVal: customSettingVal,
        waterLevel: waterLevel,
        fanMode: fanMode,
        fanIsSilent: fanIsSilent,
        autoCollect: autoCollect
    };
}

/**
 * Some setting values are encoded in setting-specific tail bytes in responses
 * on this firmware.
 *
 * @param {Buffer} body
 * @param {number} settingType
 * @returns {number|null}
 */
function decodeSettingTailValue(body, settingType) {
    if (!Buffer.isBuffer(body) || body.length < 1) {
        return null;
    }

    if (settingType === SETTING_TYPE.ROOM_PREFERENCES) {
        return body.length >= 2 ? body.readUInt8(body.length - 2) : null;
    }

    if (settingType === SETTING_TYPE.CLEANING_TIMES) {
        return body.readUInt8(body.length - 1);
    }

    return null;
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
 * @param {number} mapId
 * @param {number} roomId
 * @param {number} cleaningTimes
 * @param {number} waterLevel
 * @param {number} suctionPower
 * @returns {Buffer}
 */
/**
 * Build a SpotArea custom request with the standard 17-byte header
 * (type + mapid + 8 zeros + room_count) followed by roomCount * 30-byte blocks.
 *
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

function buildRoomPreferencesRequest(mapId, roomId, cleaningTimes, waterLevel, suctionPower) {
    const body = allocSpotAreaRoomBlockRequest(SPOT_AREA_ROOM_PREFS_TYPE, mapId, 1);
    // Room block (30 bytes) at offset 17:
    body.writeUInt8(roomId & 0xFF, 17);                   // room_index
    // bytes 18..33: zeros (padding)
    body.writeUInt32LE(suctionPower >>> 0, 34);           // suction_power
    body.writeUInt32LE(waterLevel >>> 0, 38);             // water_level
    body.writeUInt32LE(cleaningTimes >>> 0, 42);          // cleaning_times
    // byte 46: zero (padding)

    return body;
}

/**
 * Build room cleaning sequence/order SET request (type=5).
 * Room block: room_index(u8) + 28 zeros + sequence_position(u8)
 *
 * @param {number} mapId
 * @param {Array<{roomIndex:number, position:number}>} sequence - position is 1-based (0 = not in sequence)
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
 * @param {object} options
 * @param {number} options.manageType
 * @param {number} options.settingType
 * @param {number} [options.customSettingType]
 * @param {number} [options.customSettingVal]
 * @param {number} [options.waterLevel]
 * @param {number} [options.fanMode]
 * @param {number} [options.fanIsSilent]
 * @param {number} [options.autoCollectVal]
 * @returns {Buffer}
 */
function serializeSettingManageRequest(options) {
    const fixed = Buffer.alloc(24, 0);
    fixed.writeUInt8(options.manageType & 0xff, 0);
    fixed.writeUInt8(options.settingType & 0xff, 1);
    fixed.writeUInt8((options.customSettingType ?? 0) & 0xff, 2);
    fixed.writeUInt8((options.customSettingVal ?? 0) & 0xff, 3);
    fixed.writeUInt8((options.waterLevel ?? 0) & 0xff, 20);
    fixed.writeUInt8((options.fanMode ?? 0) & 0xff, 21);
    fixed.writeUInt8((options.fanIsSilent ?? 0) & 0xff, 22);

    const aiSettingVals = Buffer.alloc(5, 0);
    const aiLen = encodeUInt32(aiSettingVals.length);
    const tail = Buffer.alloc(10, 0);
    const padding = Buffer.from([0, 0]); // capture-validated
    const body = Buffer.concat([fixed, aiLen, aiSettingVals, tail, padding]);
    if (Number.isInteger(options.autoCollectVal)) {
        const value = options.autoCollectVal & 0xff;

        // Wire offsets are setting-specific on this firmware (capture-validated):
        // - settingType=14 (room preferences): second-to-last byte
        // - settingType=15 (cleaning times):   last byte
        if (options.settingType === SETTING_TYPE.ROOM_PREFERENCES) {
            body.writeUInt8(value, body.length - 2);
        } else if (options.settingType === SETTING_TYPE.CLEANING_TIMES) {
            body.writeUInt8(value, body.length - 1);
        } else if (options.settingType === SETTING_TYPE.AUTO_COLLECT) {
            body.writeUInt8(value, body.length - 3);
        } else {
            throw new Error(`Unsupported autoCollectVal settingType=${options.settingType}`);
        }
    }

    return body;
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

/**
 * @param {Array<number>} values
 * @returns {Buffer}
 */
function encodeUInt8Array(values) {
    const data = Buffer.from(values.map(v => v & 0xff));

    return Buffer.concat([encodeUInt32(data.length), data]);
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function encodeUInt32(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value >>> 0, 0);

    return out;
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function encodeFloat32(value) {
    const out = Buffer.alloc(4);
    out.writeFloatLE(value, 0);

    return out;
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function looksLikeCoord(value) {
    return Number.isFinite(value) && Math.abs(value) <= 20_000;
}

module.exports = EcovacsRosFacade;
module.exports.LIFESPAN_PART = LIFESPAN_PART;
