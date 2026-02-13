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
        // capture-validated md5, generated class md5 can differ on device
        md5: process.env.ROS_SETTING_MD5 ?? "9b750807a5def60e40619d50b06ae034",
        candidates: ["/setting/SettingManage", "/setting/settingManage", "/setting/setting_manage"]
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

const SETTING_TYPE = {
    ROOM_PREFERENCES: 14,
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
        this.masterClient = new RosMasterXmlRpcClient({
            masterUri: masterUri,
            timeoutMs: options.connectTimeoutMs ?? 4000
        });
        this.callerId = callerId;

        this.mapClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.map.candidates,
            serviceMd5: SERVICES.map.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: debug
        });
        this.spotAreaClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.spotArea.candidates,
            serviceMd5: SERVICES.spotArea.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: debug
        });
        this.chargerClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.charger.candidates,
            serviceMd5: SERVICES.charger.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: debug
        });
        this.traceClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.trace.candidates,
            serviceMd5: SERVICES.trace.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: debug
        });
        this.virtualWallClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.virtualWall.candidates,
            serviceMd5: SERVICES.virtualWall.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            persistent: false,
            debug: debug
        });
        this.workClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.work.candidates,
            serviceMd5: SERVICES.work.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            persistent: false,
            debug: debug
        });
        this.settingClient = new PersistentServiceClient({
            masterClient: this.masterClient,
            callerId: this.callerId,
            serviceCandidates: SERVICES.setting.candidates,
            serviceMd5: SERVICES.setting.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            persistent: false,
            debug: debug
        });

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
     * @returns {Promise<{header:{result:number,mapid:number,areasId:number,areaCount:number},rooms:Array<any>,roomPreferences:any}>}
     */
    async getRooms(mapId) {
        const body = await this.callSpotAreaGetWithFallback(mapId);

        const header = parseRoomsHeaderOnly(body);
        const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);
        const roomPreferences = decodeRoomPreferencesFromGetResponse(body);
        const preferencesByIndex = {};
        for (const pref of roomPreferences.rooms) {
            preferencesByIndex[pref.index] = pref;
        }

        return {
            header: header,
            rooms: rooms.map(room => {
                return {
                    index: room.index,
                    offset: room.offset,
                    point_count: room.pointCount,
                    bbox: room.bbox,
                    polygon: room.polygon,
                    metadata_prefix_len: room.metadataPrefixLen,
                    label_id: room.labelId,
                    label_name: labelNameFromId(room.labelId),
                    preference_slot: preferencesByIndex[room.index]?.slot ?? null,
                    preference_meta_words_le: preferencesByIndex[room.index]?.meta_words_le ?? [],
                    preference_meta_hex: preferencesByIndex[room.index]?.meta_hex ?? ""
                };
            }),
            roomPreferences: roomPreferences
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
            header: parseRoomsHeaderOnly(body),
            response: parseRoomPreferencesResponse(body)
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
     * @returns {Promise<"on"|"off">}
     */
    async getRoomPreferencesEnabled() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.ROOM_PREFERENCES
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
     * @param {Buffer} request
     * @returns {Promise<number>}
     */
    async callWorkManage(request) {
        Logger.info(
            `Ecovacs WorkManage request: bytes=${request.length} preview=${request.subarray(0, Math.min(24, request.length)).toString("hex")}`
        );
        const body = await this.workClient.call(request);
        Logger.info(
            `Ecovacs WorkManage response: bytes=${body.length} hex=${body.toString("hex")}`
        );

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
 * @param {Buffer} body
 * @returns {any}
 */
function decodeRoomPreferencesFromGetResponse(body) {
    const header = parseRoomsHeaderOnly(body);
    const rooms = extractRoomPolygonsDeterministic(body, header.areaCount);
    const decodedRooms = rooms.map(room => {
        const metaStart = room.offset - room.metadataPrefixLen;
        const meta = body.subarray(metaStart, room.offset);
        if (meta.length === 0) {
            return {
                index: room.index,
                label_id: room.labelId,
                slot: null,
                meta_hex: "",
                meta_words_le: []
            };
        }
        const slot = meta[0];
        const core = meta.length >= 2 ? meta.subarray(1, meta.length - 1) : Buffer.alloc(0);
        const words = [];
        for (let i = 0; i + 3 < core.length; i += 4) {
            words.push(core.readUInt32LE(i));
        }

        return {
            index: room.index,
            label_id: room.labelId,
            slot: slot,
            meta_hex: meta.toString("hex"),
            meta_words_le: words
        };
    });
    const selectedRoomTail = parseRoomPreferencesResponse(body);

    return {
        header: header,
        selected_room_tail: selectedRoomTail,
        rooms: decodedRooms
    };
}

/**
 * @param {Buffer} body
 * @returns {any}
 */
function parseRoomPreferencesResponse(body) {
    if (body.length < 20) {
        return null;
    }
    const tail = body.subarray(body.length - 20);
    const values = [
        tail.readUInt32BE(0),
        tail.readUInt32BE(4),
        tail.readUInt32BE(8),
        tail.readUInt32BE(12),
        tail.readUInt32BE(16)
    ];

    return {
        room_selector: values[0],
        cleaning_times: values[1],
        water_level: values[2],
        suction_power: values[3],
        reserved: values[4]
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
 * @returns {{response:number,settingType:number,customSettingVal:number,autoCollect:number}}
 */
function parseSettingManageResponse(body) {
    const cursor = new BinaryCursor(body);
    const response = cursor.readUInt8();
    const settingType = cursor.readUInt8();
    const customType = cursor.readUInt8();
    const customSettingVal = cursor.readUInt8();
    cursor.readBuffer(20); // remainder of 24-byte fixed block
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
        autoCollect: autoCollect
    };
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
function buildRoomPreferencesRequest(mapId, roomId, cleaningTimes, waterLevel, suctionPower) {
    const body = Buffer.from(
        "0499698751000000000000000002000000000000000000000000000000000000000001000000010000000200000000010000000000000000000000000000000000000000010000000100000000",
        "hex"
    );
    body.writeUInt32LE(mapId >>> 0, 1);
    body.writeUInt32BE(roomId >>> 0, 44);
    body.writeUInt32LE(cleaningTimes >>> 0, 64);
    body.writeUInt32LE(waterLevel >>> 0, 68);
    body.writeUInt32LE(suctionPower >>> 0, 72);

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
 * @param {number} [options.autoCollectVal]
 * @returns {Buffer}
 */
function serializeSettingManageRequest(options) {
    const fixed = Buffer.alloc(24, 0);
    fixed.writeUInt8(options.manageType & 0xff, 0);
    fixed.writeUInt8(options.settingType & 0xff, 1);
    fixed.writeUInt8((options.customSettingType ?? 0) & 0xff, 2);
    fixed.writeUInt8((options.customSettingVal ?? 0) & 0xff, 3);

    const aiSettingVals = Buffer.alloc(5, 0);
    const aiLen = encodeUInt32(aiSettingVals.length);
    const tail = Buffer.alloc(10, 0);
    if (Number.isInteger(options.autoCollectVal)) {
        tail.writeUInt8(options.autoCollectVal & 0xff, 9);
    }
    const padding = Buffer.from([0, 0]); // capture-validated

    return Buffer.concat([fixed, aiLen, aiSettingVals, tail, padding]);
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
