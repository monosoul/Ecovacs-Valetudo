const capabilities = require("./capabilities");
const EcovacsRosFacade = require("./ros/services/EcovacsRosFacade");
const entities = require("../../entities");
const fs = require("fs");
const Logger = require("../../Logger");
const lzma = require("lzma-purejs");
const mapEntities = require("../../entities/map");
const MdsctlClient = require("./ros/services/MdsctlClient");
const ValetudoRobot = require("../../core/ValetudoRobot");
require("./lzmaPurejsPkgIncludes");

const stateAttrs = entities.state.attributes;
const REMOTE_MOVE_MVA_CUSTOM = 9;
const REMOTE_MOVE_FORWARD = 0;
const REMOTE_MOVE_BACKWARD = 1;
const REMOTE_MOVE_STOP = 2;
const REMOTE_TURN_W = 87;
const SOUND_I_AM_HERE = 30;
const SOUND_BEEP = 17;
const DEFAULT_RUNTIME_STATE_CACHE_PATH = "/tmp/valetudo_ecovacs_runtime_state.json";
const WORK_STATE = {
    IDLE: 0,
    RUNNING: 1,
    PAUSED: 2
};
const WORK_TYPE = {
    AUTO_CLEAN: 0,
    AREA_CLEAN: 1,
    CUSTOM_CLEAN: 2,
    RETURN: 5,
    GOTO: 6,
    IDLE: 7,
    REMOTE_CONTROL: 9,
    AUTO_COLLECT_DIRT: 13
};

class EcovacsT8AiviValetudoRobot extends ValetudoRobot {
    /**
     * @param {object} options
     * @param {import("../../Configuration")} options.config
     * @param {import("../../ValetudoEventStore")} options.valetudoEventStore
     */
    constructor(options) {
        super(options);

        const implementationSpecificConfig = options.config.get("robot")?.implementationSpecificConfig ?? {};

        this.mapPixelSizeCm = implementationSpecificConfig.mapPixelSizeCm ?? 5;
        this.detailedMapUpgradeEnabled = implementationSpecificConfig.detailedMapUpgradeEnabled ?? false;
        this.detailedMapMaxLayerPixels = implementationSpecificConfig.detailedMapMaxLayerPixels ?? 900_000;
        this.detailedMapMinFloorPixels = implementationSpecificConfig.detailedMapMinFloorPixels ?? 1_000;
        this.detailedMapMinFloorCoverageRatio = implementationSpecificConfig.detailedMapMinFloorCoverageRatio ?? 0.2;
        this.detailedMapRefreshIntervalMs = implementationSpecificConfig.detailedMapRefreshIntervalMs ?? 120_000;
        this.detailedMapRotationDegrees = implementationSpecificConfig.detailedMapRotationDegrees ?? 270;
        this.detailedMapWorldMmPerPixel = implementationSpecificConfig.detailedMapWorldMmPerPixel ?? 50;
        this.livePositionPollIntervalMs = implementationSpecificConfig.livePositionPollIntervalMs ?? 1500;
        this.livePositionCommandTimeoutMs = implementationSpecificConfig.livePositionCommandTimeoutMs ?? 4000;
        this.powerStatePollIntervalMs = implementationSpecificConfig.powerStatePollIntervalMs ?? 3000;
        this.cleaningSettingsPollIntervalMs = implementationSpecificConfig.cleaningSettingsPollIntervalMs ?? 30_000;
        this.powerStateStaleAfterMs = implementationSpecificConfig.powerStateStaleAfterMs ?? 300_000;
        this.workStateStaleAfterMs = implementationSpecificConfig.workStateStaleAfterMs ?? 20_000;
        this.runtimeStateCachePath = implementationSpecificConfig.runtimeStateCachePath ?? DEFAULT_RUNTIME_STATE_CACHE_PATH;
        this.runtimeStateCacheWriteMinIntervalMs = implementationSpecificConfig.runtimeStateCacheWriteMinIntervalMs ?? 5000;
        this.tracePathEnabled = implementationSpecificConfig.tracePathEnabled ?? true;
        this.tracePointUnitMm = implementationSpecificConfig.tracePointUnitMm ?? 10;
        this.tracePathMaxPoints = implementationSpecificConfig.tracePathMaxPoints ?? 2000;
        this.traceTailEntries = implementationSpecificConfig.traceTailEntries ?? 1;
        this.rosDebug = implementationSpecificConfig.rosDebug ?? true;
        this.manualControlSessionCode = implementationSpecificConfig.manualControlSessionCode;
        this.manualControlActiveFlag = false;
        this.lastRobotPose = null;
        this.cachedCompressedMap = null;
        this.cachedCompressedMapAt = 0;
        this.livePositionPollTimer = null;
        this.livePositionPollInFlight = false;
        this.powerStatePollTimer = null;
        this.cleaningSettingsPollTimer = null;
        this.runtimeStateCache = this.loadRuntimeStateCache();
        this.lastRuntimeStateCacheWriteAt = 0;
        this.runtimeStateCacheWriteTimer = null;
        this.livePositionRefreshCounter = 0;
        this.tracePathPointsMm = [];
        this.lastTraceEndIdx = -1;
        this.lastTraceMapId = null;
        this.activeMapId = 0;
        this.tracePathWarningShown = false;
        this.rosFacade = new EcovacsRosFacade({
            masterUri: implementationSpecificConfig.rosMasterUri,
            callerId: implementationSpecificConfig.rosCallerId,
            connectTimeoutMs: implementationSpecificConfig.rosConnectTimeoutMs ?? 4_000,
            callTimeoutMs: implementationSpecificConfig.rosCallTimeoutMs ?? 6_000,
            debug: this.rosDebug,
            onWarn: (msg, err) => Logger.debug(`Ecovacs ROS: ${msg}: ${err ?? ""}`)
        });
        this.mdsctlClient = new MdsctlClient({
            binaryPath: implementationSpecificConfig.mdsctlBinaryPath,
            socketPath: implementationSpecificConfig.mdsctlSocketPath,
            timeoutMs: implementationSpecificConfig.mdsctlTimeoutMs ?? 2_000
        });

        this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
            value: stateAttrs.DockStatusStateAttribute.VALUE.IDLE
        }));
        const cachedChargeState = this.runtimeStateCache?.chargeState;
        const isCachedDocked = Boolean(
            cachedChargeState &&
            Number.isFinite(Number(cachedChargeState.isOnCharger)) &&
            Number(cachedChargeState.isOnCharger) > 0
        );
        const initialStatus = isCachedDocked ?
            stateAttrs.StatusStateAttribute.VALUE.DOCKED :
            stateAttrs.StatusStateAttribute.VALUE.IDLE;
        const cachedBatteryLevel = Number(this.runtimeStateCache?.battery?.level);
        const cachedBatteryFlag = this.runtimeStateCache?.battery?.flag;
        const batteryLevel = Number.isFinite(cachedBatteryLevel) ? clampInt(cachedBatteryLevel, 0, 100) : 0;
        const batteryFlag = Object.values(stateAttrs.BatteryStateAttribute.FLAG).includes(cachedBatteryFlag) ?
            cachedBatteryFlag :
            stateAttrs.BatteryStateAttribute.FLAG.NONE;
        this.state.upsertFirstMatchingAttribute(new stateAttrs.BatteryStateAttribute({
            level: batteryLevel,
            flag: batteryFlag
        }));
        this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
            type: stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW
        }));
        this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
            type: stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM
        }));
        this.setStatus(initialStatus);
        this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
            value: statusToDockStatus(initialStatus)
        }));

        const cachedPose = this.runtimeStateCache?.robotPose;
        if (cachedPose && Number.isFinite(cachedPose.x) && Number.isFinite(cachedPose.y)) {
            this.lastRobotPose = {
                x: Number(cachedPose.x),
                y: Number(cachedPose.y),
                angle: Number(cachedPose.angle ?? 0)
            };
        }

        this.registerCapability(new capabilities.EcovacsBasicControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsManualControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsLocateCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsAutoEmptyDockManualTriggerCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsCarpetModeControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsCleanRouteControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsConsumableMonitoringCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsFanSpeedControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsWaterUsageControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsMapSegmentEditCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsMapSegmentRenameCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsMapSegmentationCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsZoneCleaningCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsCombinedVirtualRestrictionsCapability({robot: this}));
    }

    getManufacturer() {
        return "Ecovacs";
    }

    getModelName() {
        return "T8 AIVI";
    }

    startup() {
        super.startup();
        Logger.info("Ecovacs ROS backend mode enabled");

        setTimeout(() => {
            this.pollMap();
        }, 2000);

        void this.rosFacade.startup();

        this.livePositionPollTimer = setInterval(() => {
            void this.refreshLiveMapEntities();
        }, this.livePositionPollIntervalMs);
        this.powerStatePollTimer = setInterval(() => {
            this.refreshRuntimeState();
        }, this.powerStatePollIntervalMs);
        this.cleaningSettingsPollTimer = setInterval(() => {
            void this.refreshCleaningSettingsState();
        }, this.cleaningSettingsPollIntervalMs);
        void this.refreshCleaningSettingsState();
    }

    /**
     * @returns {Promise<void>}
     */
    async executeMapPoll() {
        const pollStartedAt = Date.now();

        try {
            const requestedMapId = this.getActiveMapId();
            Logger.debug(`Ecovacs map poll: fetching rooms (mapId=${requestedMapId})`);
            let roomDump = await this.rosFacade.getRooms(requestedMapId);
            if ((!Array.isArray(roomDump?.rooms) || roomDump.rooms.length === 0) && requestedMapId !== 0) {
                Logger.debug("Ecovacs map poll: rooms empty for active map, retrying with mapId=0");
                roomDump = await this.rosFacade.getRooms(0);
            }
            if (Number.isInteger(roomDump?.header?.mapid)) {
                this.activeMapId = roomDump.header.mapid >>> 0;
            }
            const mapId = this.getActiveMapId();

            if (!Array.isArray(roomDump.rooms) || roomDump.rooms.length === 0) {
                throw new Error("No room polygons returned by ManipulateSpotArea");
            }
            Logger.debug(`Ecovacs map poll: rooms fetched (${roomDump.rooms.length})`);

            let positions = undefined;
            try {
                positions = await this.rosFacade.getPositions(mapId);
                Logger.debug("Ecovacs map poll: positions fetched");
            } catch (e) {
                // Positions are optional for this first map integration step.
                Logger.warn("Ecovacs map poll: positions unavailable", e?.message ?? e);
            }
            let virtualWalls = [];
            try {
                virtualWalls = await this.rosFacade.getVirtualWalls(mapId);
                Logger.debug(`Ecovacs map poll: virtual walls fetched (${virtualWalls.length})`);
            } catch (e) {
                Logger.warn("Ecovacs map poll: virtual walls unavailable", e?.message ?? e);
            }

            this.updateRobotPoseFromPositions(positions);
            const robotPoseSnapshot = this.getCurrentRobotPoseOrNull();

            const simplifiedMap = this.buildMapFromRooms(
                roomDump.rooms,
                positions,
                robotPoseSnapshot,
                undefined,
                virtualWalls
            );
            const simplifiedWithDynamicEntities = rebuildEntitiesOnlyMap(
                simplifiedMap,
                positions,
                robotPoseSnapshot,
                this.tracePathPointsMm
            ) ?? simplifiedMap;
            if (this.rosDebug) {
                Logger.info(`Ecovacs map poll: simplified map stats ${formatMapStats(simplifiedWithDynamicEntities)}`);
            }
            Logger.debug(
                `Ecovacs entities: simplified robot=${hasRobotEntity(simplifiedWithDynamicEntities)} charger=${hasChargerEntity(simplifiedWithDynamicEntities)}`
            );

            // Publish only detailed map in normal flow.
            try {
                const detailedMapStart = Date.now();
                let compressedMap = this.cachedCompressedMap;
                const cacheAgeMs = Date.now() - this.cachedCompressedMapAt;
                const cacheValid = compressedMap !== null && cacheAgeMs >= 0 && cacheAgeMs < this.detailedMapRefreshIntervalMs;
                if (cacheValid) {
                    Logger.debug(`Ecovacs map poll: using cached compressed map (${cacheAgeMs}ms old)`);
                } else {
                    Logger.debug("Ecovacs map poll: fetching compressed map");
                    const compressedRaw = await this.rosFacade.getCompressedMap(mapId);
                    Logger.debug("Ecovacs map poll: decoding compressed map submaps");
                    compressedMap = decodeCompressedMapResponse(compressedRaw);
                    this.cachedCompressedMap = compressedMap;
                    this.cachedCompressedMapAt = Date.now();
                    Logger.debug(
                        `Ecovacs map poll: decoded compressed map (${compressedMap.width}x${compressedMap.height})`
                    );
                }
                const detailedMap = this.buildDetailedMapAlignedToSimplified(
                    roomDump.rooms,
                    positions,
                    robotPoseSnapshot,
                    compressedMap,
                    virtualWalls
                );
                const detailedWithDynamicEntities = rebuildEntitiesOnlyMap(
                    detailedMap,
                    positions,
                    robotPoseSnapshot,
                    this.tracePathPointsMm
                ) ?? detailedMap;
                const detailedPixels = getTotalLayerPixelCount(detailedMap);
                const simpleFloorPixels = getLayerPixelCountByType(simplifiedWithDynamicEntities, mapEntities.MapLayer.TYPE.FLOOR);
                const detailedFloorPixels = getLayerPixelCountByType(detailedWithDynamicEntities, mapEntities.MapLayer.TYPE.FLOOR);
                const floorCoverageRatio = simpleFloorPixels > 0 ? (detailedFloorPixels / simpleFloorPixels) : 0;
                if (this.rosDebug) {
                    Logger.info(`Ecovacs map poll: detailed map stats ${formatMapStats(detailedWithDynamicEntities)}`);
                }
                Logger.debug(
                    `Ecovacs entities: detailed robot=${hasRobotEntity(detailedWithDynamicEntities)} charger=${hasChargerEntity(detailedWithDynamicEntities)}`
                );
                if (detailedPixels > this.detailedMapMaxLayerPixels) {
                    Logger.warn(
                        `Ecovacs map poll: detailed map too large (${detailedPixels} px > ${this.detailedMapMaxLayerPixels} px), keeping simplified map`
                    );
                    return;
                }
                if (detailedFloorPixels < this.detailedMapMinFloorPixels) {
                    Logger.warn(
                        `Ecovacs map poll: detailed floor too small (${detailedFloorPixels} px < ${this.detailedMapMinFloorPixels} px), keeping simplified map`
                    );
                    return;
                }
                if (floorCoverageRatio < this.detailedMapMinFloorCoverageRatio) {
                    Logger.warn(
                        `Ecovacs map poll: detailed floor coverage too low (${floorCoverageRatio.toFixed(3)} < ${this.detailedMapMinFloorCoverageRatio}), using simplified fallback`
                    );
                    this.state.map = simplifiedWithDynamicEntities;
                    this.emitMapUpdated();
                    return;
                }
                this.state.map = detailedWithDynamicEntities;
                this.emitMapUpdated();
                if (this.rosDebug) {
                    Logger.info(`Ecovacs map poll: detailed map upgraded in ${Date.now() - detailedMapStart}ms`);
                }
            } catch (e) {
                Logger.warn("Ecovacs map poll: detailed map unavailable, using simplified fallback", e?.message ?? e);
                this.state.map = simplifiedWithDynamicEntities;
                this.emitMapUpdated();
            }
        } catch (e) {
            Logger.warn("Failed to poll Ecovacs map", e);
            throw e;
        } finally {
            Logger.debug(`Ecovacs map poll: done in ${Date.now() - pollStartedAt}ms`);
        }
    }

    setStatus(value, flag) {
        this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
            value: value,
            flag: flag ?? stateAttrs.StatusStateAttribute.FLAG.NONE
        }));
        this.emitStateAttributesUpdated();
    }

    getManualControlSessionCode() {
        if (this.manualControlSessionCode === undefined || this.manualControlSessionCode === null || this.manualControlSessionCode === "") {
            throw new Error(
                "Missing robot.implementationSpecificConfig.manualControlSessionCode for Ecovacs manual control session setup."
            );
        }

        return this.manualControlSessionCode;
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runStartCleanCommand(args) {
        const command = String(args?.[0] ?? "").toLowerCase();
        Logger.info(`Ecovacs command start-clean: ${command} args=${JSON.stringify(args ?? [])}`);
        let responseCode = null;
        switch (command) {
            case "start":
                responseCode = await this.rosFacade.startAutoClean();
                break;
            case "stop":
                responseCode = await this.rosFacade.stopCleaning();
                break;
            case "pause":
                responseCode = await this.rosFacade.pauseCleaning();
                break;
            case "resume":
                responseCode = await this.rosFacade.resumeCleaning();
                break;
            case "home":
                responseCode = await this.rosFacade.returnToDock();
                break;
            case "empty":
                responseCode = await this.rosFacade.autoCollectDirt();
                break;
            case "room":
                responseCode = await this.rosFacade.startRoomClean(parseCsvUint8(String(args?.[1] ?? "")));
                break;
            case "custom":
                responseCode = await this.rosFacade.startCustomClean(parseRectArgs(args.slice(1)));
                break;
            case "remote-forward":
                responseCode = await this.rosFacade.remoteMove(REMOTE_MOVE_FORWARD);
                break;
            case "remote-backward":
                responseCode = await this.rosFacade.remoteMove(REMOTE_MOVE_BACKWARD);
                break;
            case "remote-stop":
                responseCode = await this.rosFacade.remoteMove(REMOTE_MOVE_STOP);
                break;
            case "remote-turn-left":
                responseCode = await this.rosFacade.remoteMove(REMOTE_MOVE_MVA_CUSTOM, -REMOTE_TURN_W);
                break;
            case "remote-turn-right":
                responseCode = await this.rosFacade.remoteMove(REMOTE_MOVE_MVA_CUSTOM, REMOTE_TURN_W);
                break;
            case "remote-session-open":
                await this.remoteSessionOpen(String(args?.[1] ?? ""));
                break;
            case "remote-session-close":
                await this.remoteSessionClose();
                break;
            case "remote-hold-forward":
                await this.remoteHold(REMOTE_MOVE_FORWARD, 0, Number(args?.[1] ?? 1.0));
                break;
            case "remote-hold-backward":
                await this.remoteHold(REMOTE_MOVE_BACKWARD, 0, Number(args?.[1] ?? 1.0));
                break;
            case "remote-hold-turn-left":
                await this.remoteHold(REMOTE_MOVE_MVA_CUSTOM, -REMOTE_TURN_W, Number(args?.[1] ?? 1.0));
                break;
            case "remote-hold-turn-right":
                await this.remoteHold(REMOTE_MOVE_MVA_CUSTOM, REMOTE_TURN_W, Number(args?.[1] ?? 1.0));
                break;
            default:
                throw new Error(`Unsupported start clean command: ${command}`);
        }
        if (responseCode !== null) {
            Logger.info(`Ecovacs command result: ${command} response=${responseCode}`);
        }

        return {stdout: "", stderr: ""};
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runSettingsCommand(args) {
        const action = String(args?.[0] ?? "").toLowerCase();
        const setting = String(args?.[1] ?? "").toLowerCase();
        if (!["suction_boost_on_carpet", "carpet_boost", "room_preferences"].includes(setting)) {
            throw new Error(`Unsupported setting command: ${action} ${setting}`);
        }

        if (action === "get") {
            let value;
            if (setting === "room_preferences") {
                value = await this.rosFacade.getRoomPreferencesEnabled();
            } else {
                value = await this.rosFacade.getSuctionBoostOnCarpet();
            }

            return {
                stdout: `${setting}: ${value}`,
                stderr: ""
            };
        }
        if (action === "set") {
            const onOff = String(args?.[2] ?? "").toLowerCase();
            if (!["on", "off"].includes(onOff)) {
                throw new Error(`Invalid value for ${setting}: ${onOff}`);
            }
            if (setting === "room_preferences") {
                await this.rosFacade.setRoomPreferencesEnabled(onOff);
            } else {
                await this.rosFacade.setSuctionBoostOnCarpet(onOff);
            }

            return {
                stdout: `Set ${setting}: ${onOff}`,
                stderr: ""
            };
        }

        throw new Error(`Unsupported settings action: ${action}`);
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runSoundCommand(args) {
        const command = String(args?.[0] ?? "").toLowerCase();
        let fileNumber = null;
        if (command === "locate") {
            fileNumber = SOUND_I_AM_HERE;
        } else if (command === "beep") {
            fileNumber = SOUND_BEEP;
        } else if (command === "play-sound") {
            fileNumber = Number(args?.[1]);
            if (!Number.isFinite(fileNumber)) {
                throw new Error(`Invalid play-sound file number: ${args?.[1]}`);
            }
        } else {
            throw new Error(`Unsupported sound command: ${command}`);
        }

        await this.mdsctlClient.send("audio0", {
            todo: "audio",
            cmd: "play",
            file_number: Math.trunc(fileNumber)
        });

        return {stdout: "", stderr: ""};
    }

    /**
     * @param {string} code
     * @returns {Promise<void>}
     */
    async remoteSessionOpen(code) {
        if (!code) {
            throw new Error("remote-session-open requires a non-empty code");
        }
        await this.mdsctlClient.send("live_pwd", {
            todo: "setPwdState",
            state: 1
        });
        await this.mdsctlClient.send("live_pwd", {
            todo: "onLiveLaunchPwdState",
            state: 1,
            password: String(code)
        });
        await this.mdsctlClient.send("rosnode", {
            todo: "start_push_stream",
            light_state: 1
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async remoteSessionClose() {
        await this.mdsctlClient.send("rosnode", {
            todo: "stop_push_stream"
        });
    }

    /**
     * @param {number} moveType
     * @param {number} w
     * @param {number} durationSec
     * @returns {Promise<void>}
     */
    async remoteHold(moveType, w, durationSec) {
        const durationMs = Math.max(0, Number(durationSec) * 1000);
        const intervalMs = 200;
        const deadline = Date.now() + durationMs;
        while (Date.now() < deadline) {
            await this.rosFacade.remoteMove(moveType, w);
            await delay(intervalMs);
        }
        await this.rosFacade.remoteMove(REMOTE_MOVE_STOP);
    }

    async shutdown() {
        if (this.livePositionPollTimer) {
            clearInterval(this.livePositionPollTimer);
            this.livePositionPollTimer = null;
        }
        if (this.powerStatePollTimer) {
            clearInterval(this.powerStatePollTimer);
            this.powerStatePollTimer = null;
        }
        if (this.cleaningSettingsPollTimer) {
            clearInterval(this.cleaningSettingsPollTimer);
            this.cleaningSettingsPollTimer = null;
        }
        if (this.runtimeStateCacheWriteTimer) {
            clearTimeout(this.runtimeStateCacheWriteTimer);
            this.runtimeStateCacheWriteTimer = null;
        }
        this.flushRuntimeStateCache();

        await this.rosFacade.shutdown();
    }

    /**
     * @private
     * @param {Array<any>} rooms
     * @param {any} positions
     * @param {{x:number,y:number,angle:number}|null} robotPose
     * @param {object} [compressedMap]
     * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    buildMapFromRooms(rooms, positions, robotPose, compressedMap, virtualWalls) {
        const pixelSizeCm = compressedMap?.resolutionCm ?? this.mapPixelSizeCm;
        const parsedRooms = rooms.map(room => {
            const polygon = Array.isArray(room.polygon) ? room.polygon : [];

            return {
                index: String(room.index ?? "0"),
                labelName: room.label_name ?? `Room ${room.index ?? 0}`,
                polygonCm: polygon.map(point => {
                    return {
                        x: Math.round(Number(point[0]) / 10),
                        y: Math.round(Number(point[1]) / 10)
                    };
                })
            };
        }).filter(room => room.polygonCm.length >= 3);

        const allX = parsedRooms.flatMap(room => room.polygonCm.map(p => p.x));
        const allY = parsedRooms.flatMap(room => room.polygonCm.map(p => p.y));
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX);
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY);
        const marginCm = pixelSizeCm * 4;
        const mapWidthPx = Math.ceil((maxX - minX + 2 * marginCm) / pixelSizeCm) + 1;
        const mapHeightPx = Math.ceil((maxY - minY + 2 * marginCm) / pixelSizeCm) + 1;

        const worldToGrid = (point) => {
            const shiftedX = point.x - minX + marginCm;
            const shiftedY = maxY - point.y + marginCm;

            return {
                x: Math.floor(shiftedX / pixelSizeCm),
                y: Math.floor(shiftedY / pixelSizeCm)
            };
        };

        const floorPixelSet = new Set();
        const segmentLayers = [];
        parsedRooms.forEach(room => {
            const gridPolygon = room.polygonCm.map(worldToGrid);
            const pixels = rasterizePolygon(gridPolygon);
            if (pixels.length === 0) {
                return;
            }

            pixels.forEach(pixel => {
                floorPixelSet.add(`${pixel[0]}:${pixel[1]}`);
            });

            segmentLayers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.SEGMENT,
                pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                metaData: {
                    segmentId: room.index,
                    name: room.labelName
                }
            }));
        });

        const roomFloorPixels = Array.from(floorPixelSet).map(entry => {
            const [x, y] = entry.split(":");

            return [Number(x), Number(y)];
        });
        const roomFloorSet = new Set(roomFloorPixels.map(([x, y]) => `${x}:${y}`));

        let rasterFloorPixels = roomFloorPixels;
        let rasterWallPixels = [];
        if (compressedMap) {
            try {
                const projected = projectCompressedMapToGrid(compressedMap, mapWidthPx, mapHeightPx, roomFloorSet);
                if (projected.floorPixels.length > 0) {
                    rasterFloorPixels = projected.floorPixels;
                }
                rasterWallPixels = projected.wallPixels;
            } catch (e) {
                Logger.warn("Failed to project compressed Ecovacs raster into room grid", e);
            }
        }

        const layers = [];
        if (rasterFloorPixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.FLOOR,
                pixels: rasterFloorPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        if (rasterWallPixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.WALL,
                pixels: rasterWallPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        layers.push(...segmentLayers);

        const mapItems = [];
        const chargerPose = positions?.charger?.pose;
        if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
            const chargerGrid = worldToGrid({
                x: Math.round(chargerPose.x / 10),
                y: Math.round(chargerPose.y / 10)
            });
            mapItems.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
                points: [
                    chargerGrid.x * pixelSizeCm,
                    chargerGrid.y * pixelSizeCm
                ]
            }));
        }
        if (robotPose) {
            const robotGrid = worldToGrid({
                x: Math.round(robotPose.x / 10),
                y: Math.round(robotPose.y / 10)
            });
            mapItems.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                points: [
                    robotGrid.x * pixelSizeCm,
                    robotGrid.y * pixelSizeCm
                ],
                metaData: {
                    angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                }
            }));
        }

        const mapWidthCm = mapWidthPx * pixelSizeCm;
        const mapHeightCm = mapHeightPx * pixelSizeCm;
        const transform = {
            type: "rooms",
            marginCm: marginCm,
            maxY: maxY,
            minX: minX,
            pixelSizeCm: pixelSizeCm
        };
        mapItems.push(...buildRestrictionEntities(transform, pixelSizeCm, virtualWalls));

        return new mapEntities.ValetudoMap({
            size: {
                x: mapWidthCm,
                y: mapHeightCm
            },
            pixelSize: pixelSizeCm,
            layers: layers,
            entities: mapItems,
            metaData: {
                ecovacsTransform: transform
            }
        });
    }

    /**
     * Build detailed raster and overlays with the same transforms used by
     * scripts/decode_map_dump.py + scripts/render_rooms_overlay.py.
     *
     * @param {Array<any>} rooms
     * @param {any} positions
     * @param {{x:number,y:number,angle:number}|null} robotPose
     * @param {{width:number,height:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
     * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    buildDetailedMapAlignedToSimplified(rooms, positions, robotPose, compressedMap, virtualWalls) {
        const pixelSizeCm = Number(compressedMap.resolutionCm);
        if (!Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
            throw new Error("Invalid compressed map pixel size");
        }
        const mapRotation = normalizeClockwiseRotation(this.detailedMapRotationDegrees);
        const mmPerPixel = Number(this.detailedMapWorldMmPerPixel);
        if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
            throw new Error("Invalid detailedMapWorldMmPerPixel");
        }

        const rotatedFloor = rotatePixelsClockwise(
            compressedMap.floorPixels,
            compressedMap.width,
            compressedMap.height,
            mapRotation
        );
        const rotatedWall = rotatePixelsClockwise(
            compressedMap.wallPixels,
            compressedMap.width,
            compressedMap.height,
            mapRotation
        );
        Logger.debug(
            `Ecovacs detailed map transform: rotation=${mapRotation}deg size=${rotatedFloor.width}x${rotatedFloor.height} mm_per_pixel=${mmPerPixel}`
        );

        const mapWidthPx = rotatedFloor.width;
        const mapHeightPx = rotatedFloor.height;
        const layers = [];

        if (rotatedFloor.pixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.FLOOR,
                pixels: rotatedFloor.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        if (rotatedWall.pixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.WALL,
                pixels: rotatedWall.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }

        for (const room of (Array.isArray(rooms) ? rooms : [])) {
            const polygon = Array.isArray(room?.polygon) ? room.polygon : [];
            const polygonGrid = polygon.map(point => {
                return worldToGridScriptCompatible(
                    Number(point?.[0]),
                    Number(point?.[1]),
                    mapWidthPx,
                    mapHeightPx,
                    mmPerPixel
                );
            }).filter(Boolean).map(point => {
                return clampPointToBounds(point, mapWidthPx, mapHeightPx);
            });
            if (polygonGrid.length < 3) {
                continue;
            }
            const pixels = rasterizePolygon(polygonGrid);
            if (pixels.length === 0) {
                continue;
            }
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.SEGMENT,
                pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                metaData: {
                    segmentId: String(room.index ?? "0"),
                    name: room.label_name ?? `Room ${room.index ?? 0}`
                }
            }));
        }

        const entities = [];
        const chargerPose = positions?.charger?.pose;
        if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
            const chargerGrid = worldToGridScriptCompatible(
                Number(chargerPose.x),
                Number(chargerPose.y),
                mapWidthPx,
                mapHeightPx,
                mmPerPixel
            );
            if (chargerGrid) {
                entities.push(new mapEntities.PointMapEntity({
                    type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
                    points: [
                        chargerGrid.x * pixelSizeCm,
                        chargerGrid.y * pixelSizeCm
                    ]
                }));
            }
        }
        if (robotPose) {
            const robotGrid = worldToGridScriptCompatible(
                Number(robotPose.x),
                Number(robotPose.y),
                mapWidthPx,
                mapHeightPx,
                mmPerPixel
            );
            if (robotGrid) {
                entities.push(new mapEntities.PointMapEntity({
                    type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                    points: [
                        robotGrid.x * pixelSizeCm,
                        robotGrid.y * pixelSizeCm
                    ],
                    metaData: {
                        angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                    }
                }));
            }
        }
        const transform = {
            mapHeightPx: mapHeightPx,
            mapWidthPx: mapWidthPx,
            mmPerPixel: mmPerPixel,
            rotationDegrees: mapRotation,
            type: "script",
        };
        entities.push(...buildRestrictionEntities(transform, pixelSizeCm, virtualWalls));

        return new mapEntities.ValetudoMap({
            size: {
                x: mapWidthPx * pixelSizeCm,
                y: mapHeightPx * pixelSizeCm
            },
            pixelSize: pixelSizeCm,
            layers: layers,
            entities: entities,
            metaData: {
                ecovacsTransform: transform
            }
        });
    }

    /**
     * @private
     * @param {any} positions
     */
    updateRobotPoseFromPositions(positions) {
        const directPose = positions?.robot?.pose;
        if (directPose && typeof directPose.x === "number" && typeof directPose.y === "number") {
            this.lastRobotPose = {
                x: directPose.x,
                y: directPose.y,
                angle: Number(directPose.theta ?? directPose.angle ?? 0)
            };
            this.updateRuntimeStateCache({
                robotPose: this.lastRobotPose
            });
            return;
        }
    }

    /**
     * @private
     * @returns {{x:number,y:number,angle:number}|null}
     */
    getCurrentRobotPoseOrNull() {
        return this.lastRobotPose;
    }

    /**
     * @returns {number}
     */
    getActiveMapId() {
        return Number.isInteger(this.activeMapId) ? (this.activeMapId >>> 0) : 0;
    }

    /**
     * @param {import("../../entities/core/ValetudoZone")} zone
     * @returns {[number,number,number,number]}
     */
    mapZoneToWorldRect(zone) {
        const transform = this.state?.map?.metaData?.ecovacsTransform;
        const pixelSizeCm = Number(this.state?.map?.pixelSize ?? 0);
        if (!transform || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
            throw new Error("Map transform is not available for custom area cleaning");
        }
        const points = [zone.points?.pA, zone.points?.pB, zone.points?.pC, zone.points?.pD]
            .filter(Boolean)
            .map(point => {
                return mapCmToWorldMm(transform, Number(point.x), Number(point.y), pixelSizeCm);
            })
            .filter(Boolean);
        if (points.length === 0) {
            throw new Error("Invalid zone points");
        }
        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);

        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    /**
     * @param {{x:number,y:number}} point
     * @returns {{x:number,y:number}}
     */
    mapPointToWorld(point) {
        const transform = this.state?.map?.metaData?.ecovacsTransform;
        const pixelSizeCm = Number(this.state?.map?.pixelSize ?? 0);
        if (!transform || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
            throw new Error("Map transform is not available for virtual restrictions");
        }
        const world = mapCmToWorldMm(transform, Number(point?.x), Number(point?.y), pixelSizeCm);
        if (!world) {
            throw new Error("Invalid map point for virtual restrictions");
        }

        return world;
    }

    /**
     * @param {{x:number,y:number}} point
     * @returns {{x:number,y:number}|null}
     */
    worldPointToMap(point) {
        const transform = this.state?.map?.metaData?.ecovacsTransform;
        const pixelSizeCm = Number(this.state?.map?.pixelSize ?? 0);
        if (!transform || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
            return null;
        }
        const mapped = worldMmToMapPointCm(transform, Number(point?.x), Number(point?.y), pixelSizeCm);
        if (!mapped || mapped.length < 2) {
            return null;
        }

        return {
            x: mapped[0],
            y: mapped[1]
        };
    }

    /**
     * Refresh only robot/charger entities frequently, without rebuilding map layers.
     *
     * @returns {Promise<void>}
     */
    async refreshLiveMapEntities() {
        if (this.livePositionPollInFlight) {
            return;
        }
        if (!this.state?.map || !Array.isArray(this.state.map.layers) || this.state.map.layers.length === 0) {
            return;
        }

        this.livePositionPollInFlight = true;
        try {
            const positions = await this.rosFacade.getPositions(this.getActiveMapId());
            this.updateRobotPoseFromPositions(positions);
            if (this.tracePathEnabled) {
                try {
                    await this.updateTracePathFromService();
                } catch (e) {
                    if (!this.tracePathWarningShown) {
                        Logger.warn(
                            "Ecovacs trace path disabled for now: ROS trace service call failed.",
                            e?.message ?? e
                        );
                        this.tracePathWarningShown = true;
                    }
                }
            }
            const updated = rebuildEntitiesOnlyMap(
                this.state.map,
                positions,
                this.getCurrentRobotPoseOrNull(),
                this.tracePathPointsMm
            );
            if (updated) {
                this.state.map = updated;
                this.emitMapUpdated();
                this.livePositionRefreshCounter++;
                if (this.livePositionRefreshCounter % 20 === 0) {
                    Logger.debug(`Ecovacs live entities refreshed (${this.livePositionRefreshCounter})`);
                }
            }
        } catch (e) {
            this.livePositionRefreshCounter++;
            if (this.livePositionRefreshCounter % 20 === 0) {
                Logger.debug(`Ecovacs live entity refresh skipped: ${e?.message ?? e}`);
            }
        } finally {
            this.livePositionPollInFlight = false;
        }
    }

    refreshRuntimeState() {
        try {
            const workState = this.rosFacade.getRuntimeState()?.workState;
            const powerState = this.rosFacade.getPowerState();
            const battery = powerState?.battery;
            const chargeState = powerState?.chargeState;
            let stateChanged = false;

            if (battery && typeof battery.battery === "number") {
                const level = clampInt(battery.battery, 0, 100);
                const previous = this.state.getFirstMatchingAttributeByConstructor(stateAttrs.BatteryStateAttribute);
                let flag = previous?.flag ?? stateAttrs.BatteryStateAttribute.FLAG.NONE;

                if (chargeState && typeof chargeState.isOnCharger === "number") {
                    if (Number(chargeState.isOnCharger) > 0) {
                        if (chargeState.chargeState === 2 || level >= 100) {
                            flag = stateAttrs.BatteryStateAttribute.FLAG.CHARGED;
                        } else {
                            flag = stateAttrs.BatteryStateAttribute.FLAG.CHARGING;
                        }
                    } else {
                        flag = stateAttrs.BatteryStateAttribute.FLAG.DISCHARGING;
                    }
                }

                this.state.upsertFirstMatchingAttribute(new stateAttrs.BatteryStateAttribute({
                    level: level,
                    flag: flag
                }));
                this.updateRuntimeStateCache({
                    battery: {
                        level: level,
                        flag: flag
                    }
                });
                stateChanged = true;
            }
            if (chargeState && typeof chargeState.isOnCharger === "number" && typeof chargeState.chargeState === "number") {
                this.updateRuntimeStateCache({
                    chargeState: {
                        isOnCharger: Number(chargeState.isOnCharger),
                        chargeState: Number(chargeState.chargeState)
                    }
                });
            }

            if (!workState && !chargeState) {
                if (stateChanged) {
                    this.emitStateAttributesUpdated();
                }
                return;
            }

            const statusValue = determineRobotStatus(workState, chargeState);
            const previousStatus = this.state.getFirstMatchingAttributeByConstructor(stateAttrs.StatusStateAttribute);
            const previousStatusValue = previousStatus?.value;
            if (previousStatusValue !== statusValue) {
                Logger.debug(
                    `Ecovacs runtime status transition: ${previousStatusValue ?? "unknown"} -> ${statusValue}` +
                    ` (workState=${JSON.stringify(workState ?? null)}, chargeState=${JSON.stringify(chargeState ?? null)})`
                );
            }
            this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
                value: statusValue,
                flag: stateAttrs.StatusStateAttribute.FLAG.NONE
            }));
            this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
                value: statusToDockStatus(statusValue)
            }));
            stateChanged = true;

            if (stateChanged) {
                this.emitStateAttributesUpdated();
            }
        } catch (e) {
            Logger.debug(`Ecovacs runtime state refresh failed: ${e?.message ?? e}`);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async refreshCleaningSettingsState() {
        try {
            const [fanRaw, waterLevelRaw] = await Promise.all([
                this.rosFacade.getFanMode(),
                this.rosFacade.getWaterLevel()
            ]);
            const fanPreset = fanLevelToPresetValue(fanRaw?.mode, fanRaw?.isSilent);
            const waterPreset = waterLevelToPresetValue(waterLevelRaw);

            let changed = false;
            const currentFan = this.state.getFirstMatchingAttribute(
                attribute => {
                    return attribute instanceof stateAttrs.PresetSelectionStateAttribute &&
                        attribute.type === stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED;
                }
            );
            if (currentFan?.value !== fanPreset.value || currentFan?.customValue !== fanPreset.customValue) {
                changed = true;
            }
            this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute(fanPreset));

            const currentWater = this.state.getFirstMatchingAttribute(
                attribute => {
                    return attribute instanceof stateAttrs.PresetSelectionStateAttribute &&
                        attribute.type === stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE;
                }
            );
            if (currentWater?.value !== waterPreset.value || currentWater?.customValue !== waterPreset.customValue) {
                changed = true;
            }
            this.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute(waterPreset));

            if (changed) {
                this.emitStateAttributesUpdated();
            }
        } catch (e) {
            Logger.debug(`Ecovacs settings state refresh failed: ${e?.message ?? e}`);
        }
    }

    /**
     * @returns {{robotPose:{x:number,y:number,angle:number}|null,battery:{level:number,flag:string}|null,chargeState:{isOnCharger:number,chargeState:number}|null}}
     */
    loadRuntimeStateCache() {
        try {
            if (!fs.existsSync(this.runtimeStateCachePath)) {
                return {
                    robotPose: null,
                    battery: null,
                    chargeState: null
                };
            }
            const parsed = JSON.parse(fs.readFileSync(this.runtimeStateCachePath, "utf8"));
            const cachedChargeState = parsed?.chargeState;
            const chargeState = (
                cachedChargeState &&
                Number.isFinite(Number(cachedChargeState.isOnCharger)) &&
                Number.isFinite(Number(cachedChargeState.chargeState))
            ) ? {
                    isOnCharger: Number(cachedChargeState.isOnCharger),
                    chargeState: Number(cachedChargeState.chargeState)
                } : null;

            return {
                robotPose: parsed?.robotPose ?? null,
                battery: parsed?.battery ?? null,
                chargeState: chargeState
            };
        } catch (e) {
            Logger.debug(`Failed to read Ecovacs runtime cache: ${e?.message ?? e}`);

            return {
                robotPose: null,
                battery: null,
                chargeState: null
            };
        }
    }

    /**
     * @param {{robotPose?:{x:number,y:number,angle:number},battery?:{level:number,flag:string},chargeState?:{isOnCharger:number,chargeState:number}}} patch
     */
    updateRuntimeStateCache(patch) {
        let changed = false;
        if (patch.robotPose) {
            const pose = {
                x: Number(patch.robotPose.x),
                y: Number(patch.robotPose.y),
                angle: Number(patch.robotPose.angle ?? 0)
            };
            if (
                !this.runtimeStateCache.robotPose ||
                this.runtimeStateCache.robotPose.x !== pose.x ||
                this.runtimeStateCache.robotPose.y !== pose.y ||
                this.runtimeStateCache.robotPose.angle !== pose.angle
            ) {
                this.runtimeStateCache.robotPose = pose;
                changed = true;
            }
        }
        if (patch.battery) {
            const battery = {
                level: clampInt(Number(patch.battery.level), 0, 100),
                flag: String(patch.battery.flag)
            };
            if (
                !this.runtimeStateCache.battery ||
                this.runtimeStateCache.battery.level !== battery.level ||
                this.runtimeStateCache.battery.flag !== battery.flag
            ) {
                this.runtimeStateCache.battery = battery;
                changed = true;
            }
        }
        if (patch.chargeState) {
            const chargeState = {
                isOnCharger: Number(patch.chargeState.isOnCharger),
                chargeState: Number(patch.chargeState.chargeState)
            };
            if (
                Number.isFinite(chargeState.isOnCharger) &&
                Number.isFinite(chargeState.chargeState) &&
                (
                    !this.runtimeStateCache.chargeState ||
                    this.runtimeStateCache.chargeState.isOnCharger !== chargeState.isOnCharger ||
                    this.runtimeStateCache.chargeState.chargeState !== chargeState.chargeState
                )
            ) {
                this.runtimeStateCache.chargeState = chargeState;
                changed = true;
            }
        }
        if (changed) {
            this.scheduleRuntimeStateCacheWrite();
        }
    }

    scheduleRuntimeStateCacheWrite() {
        if (this.runtimeStateCacheWriteTimer) {
            return;
        }
        const elapsed = Date.now() - this.lastRuntimeStateCacheWriteAt;
        const delayMs = Math.max(0, this.runtimeStateCacheWriteMinIntervalMs - elapsed);
        this.runtimeStateCacheWriteTimer = setTimeout(() => {
            this.runtimeStateCacheWriteTimer = null;
            this.flushRuntimeStateCache();
        }, delayMs);
    }

    flushRuntimeStateCache() {
        try {
            fs.writeFileSync(
                this.runtimeStateCachePath,
                JSON.stringify(this.runtimeStateCache),
                "utf8"
            );
            this.lastRuntimeStateCacheWriteAt = Date.now();
        } catch (e) {
            Logger.debug(`Failed to write Ecovacs runtime cache: ${e?.message ?? e}`);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async updateTracePathFromService() {
        const trace = await this.rosFacade.getTraceLatest(this.getActiveMapId(), this.traceTailEntries);
        const traceMapId = Number(trace?.trace_mapid);
        const traceEndIdx = Number(trace?.trace_end_idx);
        const rawHex = String(trace?.trace_raw_hex ?? "");
        if (!Number.isFinite(traceMapId) || !Number.isFinite(traceEndIdx) || rawHex.length === 0) {
            return;
        }

        if (this.lastTraceMapId !== null && this.lastTraceMapId !== traceMapId) {
            this.tracePathPointsMm = [];
            this.lastTraceEndIdx = -1;
        }
        this.lastTraceMapId = traceMapId;

        if (traceEndIdx <= this.lastTraceEndIdx) {
            return;
        }
        this.lastTraceEndIdx = traceEndIdx;

        const pointsMm = decodeTraceRawHexToWorldMmPoints(rawHex, this.tracePointUnitMm);
        for (const point of pointsMm) {
            const last = this.tracePathPointsMm.length > 0 ? this.tracePathPointsMm[this.tracePathPointsMm.length - 1] : null;
            if (last && last.x === point.x && last.y === point.y) {
                continue;
            }
            this.tracePathPointsMm.push(point);
        }
        if (this.tracePathPointsMm.length > this.tracePathMaxPoints) {
            this.tracePathPointsMm = this.tracePathPointsMm.slice(this.tracePathPointsMm.length - this.tracePathMaxPoints);
        }
    }

    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        return fs.existsSync("/tmp/mds_cmd.sock") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/task") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/setting");
    }
}

/**
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {Array<[number, number]>}
 */
function rasterizePolygon(polygon) {
    const minX = Math.min(...polygon.map(p => p.x));
    const maxX = Math.max(...polygon.map(p => p.x));
    const minY = Math.min(...polygon.map(p => p.y));
    const maxY = Math.max(...polygon.map(p => p.y));

    /** @type {Array<[number, number]>} */
    const pixels = [];
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (pointInPolygon(x + 0.5, y + 0.5, polygon)) {
                pixels.push([x, y]);
            }
        }
    }

    return pixels;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * @param {string} value
 * @returns {Array<number>}
 */
function parseCsvUint8(value) {
    const parts = String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);
    if (parts.length === 0) {
        throw new Error("Expected at least one comma-separated uint8 value");
    }

    return parts.map(part => {
        const parsed = Number(part);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
            throw new Error(`Invalid uint8 value: ${part}`);
        }

        return parsed;
    });
}

/**
 * @param {Array<string>} args
 * @returns {Array<[number,number,number,number]>}
 */
function parseRectArgs(args) {
    if (args.length < 4 || args.length % 4 !== 0) {
        throw new Error("custom requires x1 y1 x2 y2 [x1 y1 x2 y2 ...]");
    }
    const values = args.map(v => Number(v));
    if (values.some(v => !Number.isFinite(v))) {
        throw new Error("custom rectangle values must be numeric");
    }
    const out = [];
    for (let i = 0; i < values.length; i += 4) {
        out.push([values[i], values[i + 1], values[i + 2], values[i + 3]]);
    }

    return out;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = EcovacsT8AiviValetudoRobot;

/**
 * @param {{mapid:number,info:{mapWidth:number,mapHeight:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolution:number},submaps:Array<{data:Buffer}>}} response
 * @returns {{width:number,height:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function decodeCompressedMapResponse(response) {
    const decodeStartedAt = Date.now();
    const info = response.info;
    const expectedSubmaps = info.columns * info.rows;
    if (!Array.isArray(response.submaps) || response.submaps.length < expectedSubmaps) {
        throw new Error(`Compressed map response incomplete: expected ${expectedSubmaps}, got ${response.submaps?.length ?? 0}`);
    }

    /** @type {Array<[number, number]>} */
    const floorPixels = [];
    /** @type {Array<[number, number]>} */
    const wallPixels = [];

    for (let tileIndex = 0; tileIndex < response.submaps.length; tileIndex++) {
        const submap = response.submaps[tileIndex];
        const decoded = decodeEcovacsCompressedSubmap(submap.data);
        const expectedTileLen = info.submapWidth * info.submapHeight;
        if (decoded.length !== expectedTileLen) {
            throw new Error(`Tile length mismatch for submap ${tileIndex}: ${decoded.length} != ${expectedTileLen}`);
        }

        const tileRow = Math.floor(tileIndex / info.columns);
        const tileCol = tileIndex % info.columns;
        const baseX = tileCol * info.submapWidth;
        const baseY = tileRow * info.submapHeight;

        for (let y = 0; y < info.submapHeight; y++) {
            const srcOffset = y * info.submapWidth;
            for (let x = 0; x < info.submapWidth; x++) {
                const value = decoded[srcOffset + x];
                const mapX = baseX + x;
                const mapY = baseY + y;
                if (value === 1) {
                    floorPixels.push([mapX, mapY]);
                } else if (value === 2 || value === 255) {
                    wallPixels.push([mapX, mapY]);
                }
            }
        }
    }

    const result = {
        width: info.mapWidth,
        height: info.mapHeight,
        columns: info.columns,
        rows: info.rows,
        submapWidth: info.submapWidth,
        submapHeight: info.submapHeight,
        resolutionCm: inferCompressedMapPixelSizeCm(info.resolution),
        floorPixels: floorPixels,
        wallPixels: wallPixels
    };
    Logger.debug(
        `Ecovacs compressed map decode: ${response.submaps.length} submaps, floor=${floorPixels.length}, wall=${wallPixels.length}, took=${Date.now() - decodeStartedAt}ms`
    );

    return result;
}

/**
 * @param {Buffer} raw
 * @returns {Uint8Array}
 */
function decodeEcovacsCompressedSubmap(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 10) {
        throw new Error("Compressed submap payload is too short");
    }

    const propsAndDict = raw.subarray(0, 5);
    const uncompressedSize = raw.readUInt32LE(5);
    const lzmaPayload = raw.subarray(9);

    const lzmaAloneHeader = Buffer.alloc(13);
    propsAndDict.copy(lzmaAloneHeader, 0, 0, 5);
    lzmaAloneHeader.writeUInt32LE(uncompressedSize, 5);
    lzmaAloneHeader.writeUInt32LE(0, 9);

    const combined = Buffer.concat([lzmaAloneHeader, lzmaPayload]);
    const decoded = lzma.decompressFile(combined);
    const out = decoded instanceof Uint8Array ? decoded : Uint8Array.from(decoded);
    if (out.length !== uncompressedSize) {
        throw new Error(`Decoded submap length mismatch: ${out.length} != ${uncompressedSize}`);
    }

    return out;
}

/**
 * Ecovacs `resolution` is observed as 50 for 5cm maps.
 * Treat values >= 20 as millimeters, otherwise centimeters.
 *
 * @param {number} raw
 * @returns {number}
 */
function inferCompressedMapPixelSizeCm(raw) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
        return 5;
    }
    if (v >= 20) {
        return Math.max(1, Math.round(v / 10));
    }

    return Math.max(1, Math.round(v));
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<string>} roomFloorSet
 * @returns {{floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function projectCompressedMapToGrid(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const projectionStartedAt = Date.now();
    const orientation = chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet);
    const floorSet = new Set();
    const wallSet = new Set();

    for (const [sx, sy] of compressedMap.floorPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            floorSet.add(`${p[0]}:${p[1]}`);
        }
    }
    for (const [sx, sy] of compressedMap.wallPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            wallSet.add(`${p[0]}:${p[1]}`);
        }
    }

    const result = {
        floorPixels: Array.from(floorSet).map(splitPixelKey),
        wallPixels: Array.from(wallSet).map(splitPixelKey)
    };
    Logger.debug(
        `Ecovacs compressed map projection: orientation=${orientation}, floor=${result.floorPixels.length}, wall=${result.wallPixels.length}, took=${Date.now() - projectionStartedAt}ms`
    );

    return result;
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<string>} roomFloorSet
 * @returns {number}
 */
function chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const maxSample = 4000;
    const step = Math.max(1, Math.floor(compressedMap.floorPixels.length / maxSample));

    let bestOrientation = 0;
    let bestScore = -1;
    for (let orientation = 0; orientation < 8; orientation++) {
        let score = 0;
        let checked = 0;
        for (let i = 0; i < compressedMap.floorPixels.length; i += step) {
            const [sx, sy] = compressedMap.floorPixels[i];
            const p = projectSourcePointToTarget(
                sx,
                sy,
                compressedMap.width,
                compressedMap.height,
                targetWidth,
                targetHeight,
                orientation
            );
            if (!p) {
                continue;
            }
            checked++;
            if (roomFloorSet.has(`${p[0]}:${p[1]}`)) {
                score++;
            }
        }
        const normalized = checked > 0 ? (score / checked) : 0;
        if (normalized > bestScore) {
            bestScore = normalized;
            bestOrientation = orientation;
        }
    }

    return bestOrientation;
}

/**
 * @param {number} sx
 * @param {number} sy
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {number} orientation
 * @returns {[number, number]|null}
 */
function projectSourcePointToTarget(sx, sy, srcWidth, srcHeight, targetWidth, targetHeight, orientation) {
    const transformed = orientPoint(sx, sy, srcWidth, srcHeight, orientation);
    if (!transformed) {
        return null;
    }
    const [ox, oy, ow, oh] = transformed;
    if (ow <= 1 || oh <= 1 || targetWidth <= 1 || targetHeight <= 1) {
        return null;
    }

    const tx = Math.round((ox / (ow - 1)) * (targetWidth - 1));
    const ty = Math.round((oy / (oh - 1)) * (targetHeight - 1));
    if (tx < 0 || ty < 0 || tx >= targetWidth || ty >= targetHeight) {
        return null;
    }

    return [tx, ty];
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} orientation
 * @returns {[number, number, number, number]|null}
 */
function orientPoint(x, y, width, height, orientation) {
    switch (orientation) {
        case 0:
            return [x, y, width, height];
        case 1:
            return [width - 1 - x, y, width, height];
        case 2:
            return [x, height - 1 - y, width, height];
        case 3:
            return [width - 1 - x, height - 1 - y, width, height];
        case 4:
            return [y, x, height, width];
        case 5:
            return [height - 1 - y, x, height, width];
        case 6:
            return [y, width - 1 - x, height, width];
        case 7:
            return [height - 1 - y, width - 1 - x, height, width];
        default:
            return null;
    }
}

/**
 * @param {string} key
 * @returns {[number, number]}
 */
function splitPixelKey(key) {
    const [x, y] = key.split(":");

    return [Number(x), Number(y)];
}

/**
 * @param {number} rotation
 * @returns {number}
 */
function normalizeClockwiseRotation(rotation) {
    const raw = Number(rotation);
    if (!Number.isFinite(raw)) {
        return 270;
    }
    const normalized = ((Math.round(raw) % 360) + 360) % 360;
    if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }

    return 270;
}

/**
 * Rotate pixel tuples by 0/90/180/270 degrees clockwise.
 *
 * @param {Array<[number,number]>} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} rotation
 * @returns {{pixels:Array<[number,number]>,width:number,height:number}}
 */
function rotatePixelsClockwise(pixels, width, height, rotation) {
    const inPixels = Array.isArray(pixels) ? pixels : [];
    const out = [];
    if (rotation === 0) {
        for (const [x, y] of inPixels) {
            out.push([x, y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 180) {
        for (const [x, y] of inPixels) {
            out.push([width - 1 - x, height - 1 - y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 90) {
        for (const [x, y] of inPixels) {
            out.push([height - 1 - y, x]);
        }

        return {pixels: out, width: height, height: width};
    }
    if (rotation === 270) {
        for (const [x, y] of inPixels) {
            out.push([y, width - 1 - x]);
        }

        return {pixels: out, width: height, height: width};
    }

    return {pixels: out, width: width, height: height};
}

/**
 * Same center-based transform as scripts/render_rooms_overlay.py.
 *
 * @param {number} worldXmm
 * @param {number} worldYmm
 * @param {number} mapWidthPx
 * @param {number} mapHeightPx
 * @param {number} mmPerPixel
 * @returns {{x:number,y:number}|null}
 */
function worldToGridScriptCompatible(worldXmm, worldYmm, mapWidthPx, mapHeightPx, mmPerPixel) {
    if (!Number.isFinite(worldXmm) || !Number.isFinite(worldYmm)) {
        return null;
    }
    const cx = mapWidthPx / 2.0;
    const cy = mapHeightPx / 2.0;

    return {
        x: Math.round(cx + (worldXmm / mmPerPixel)),
        y: Math.round(cy - (worldYmm / mmPerPixel))
    };
}

/**
 * @param {{x:number,y:number}} point
 * @param {number} width
 * @param {number} height
 * @returns {{x:number,y:number}}
 */
function clampPointToBounds(point, width, height) {
    return {
        x: Math.max(0, Math.min(width - 1, Math.round(point.x))),
        y: Math.max(0, Math.min(height - 1, Math.round(point.y)))
    };
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function getTotalLayerPixelCount(map) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers.reduce((sum, layer) => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);

        return sum + (Number.isFinite(px) ? px : 0);
    }, 0);
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {string}
 */
function formatMapStats(map) {
    const widthCm = Number(map?.size?.x ?? 0);
    const heightCm = Number(map?.size?.y ?? 0);
    const pixelSize = Number(map?.pixelSize ?? 0);
    const layers = Array.isArray(map?.layers) ? map.layers : [];
    const entitiesCount = Array.isArray(map?.entities) ? map.entities.length : 0;
    const totalPixels = getTotalLayerPixelCount(map);
    const layerSummary = layers.map(layer => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);
        const cpx = Array.isArray(layer?.compressedPixels) ? layer.compressedPixels.length : 0;

        return `${layer.type}:${Number.isFinite(px) ? px : 0}(rle=${cpx})`;
    }).join(",");
    const payloadBytes = estimateMapPayloadBytes(map);

    return `size_cm=${widthCm}x${heightCm} pixel_cm=${pixelSize} layers=${layers.length} entities=${entitiesCount} layer_pixels=${totalPixels} payload_bytes=${payloadBytes} [${layerSummary}]`;
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {boolean}
 */
function hasRobotEntity(map) {
    return Array.isArray(map?.entities) && map.entities.some(entity => entity?.type === mapEntities.PointMapEntity.TYPE.ROBOT_POSITION);
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {boolean}
 */
function hasChargerEntity(map) {
    return Array.isArray(map?.entities) && map.entities.some(entity => entity?.type === mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION);
}

/**
 * Decode one ManipulateTrace raw hex chunk:
 * [5B props+dict][4B usize32 LE][LZMA stream], uncompressed records: <int16 x><int16 y><u8 flag>
 *
 * @param {string} rawHex
 * @param {number} unitMm
 * @returns {Array<{x:number,y:number,flag:number}>}
 */
function decodeTraceRawHexToWorldMmPoints(rawHex, unitMm) {
    const raw = Buffer.from(String(rawHex ?? ""), "hex");
    if (raw.length < 10) {
        return [];
    }

    const scale = Number(unitMm);
    if (!Number.isFinite(scale) || scale <= 0) {
        return [];
    }

    /** @type {Array<{x:number,y:number,flag:number}>} */
    const points = [];
    const decodedPrimary = tryDecodeSingleTraceChunk(raw);
    if (decodedPrimary !== null) {
        appendDecodedTracePoints(points, decodedPrimary, scale);
        return points;
    }

    // Fallback for concatenated tail payloads: split by observed chunk signature.
    const signature = Buffer.from([0x5d, 0x00, 0x00, 0x04, 0x00]);
    const starts = [];
    for (let i = 0; i <= raw.length - signature.length; i++) {
        let match = true;
        for (let j = 0; j < signature.length; j++) {
            if (raw[i + j] !== signature[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            starts.push(i);
        }
    }
    if (starts.length === 0) {
        return [];
    }
    starts.push(raw.length);
    for (let i = 0; i + 1 < starts.length; i++) {
        const chunk = raw.subarray(starts[i], starts[i + 1]);
        const decoded = tryDecodeSingleTraceChunk(chunk);
        if (decoded !== null) {
            appendDecodedTracePoints(points, decoded, scale);
        }
    }

    return points;
}

/**
 * @param {Array<{x:number,y:number,flag:number}>} outPoints
 * @param {Buffer} decoded
 * @param {number} scale
 */
function appendDecodedTracePoints(outPoints, decoded, scale) {
    for (let off = 0; off + 4 < decoded.length; off += 5) {
        const x = decoded.readInt16LE(off);
        const y = decoded.readInt16LE(off + 2);
        const flag = decoded.readUInt8(off + 4);
        outPoints.push({
            x: x * scale,
            y: y * scale,
            flag: flag
        });
    }
}

/**
 * @param {Buffer} raw
 * @returns {Buffer|null}
 */
function tryDecodeSingleTraceChunk(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 10) {
        return null;
    }
    try {
        const propsDict = raw.subarray(0, 5);
        const usize32 = raw.readUInt32LE(5);
        const lzmaPayload = raw.subarray(9);
        const hdr = Buffer.alloc(13);
        propsDict.copy(hdr, 0, 0, 5);
        hdr.writeUInt32LE(usize32, 5);
        hdr.writeUInt32LE(0, 9);
        const outRaw = lzma.decompressFile(Buffer.concat([hdr, lzmaPayload]));
        const out = outRaw instanceof Uint8Array ? Buffer.from(outRaw) : Buffer.from(outRaw ?? []);
        if (out.length < 5) {
            return null;
        }

        return out;
    } catch (e) {
        return null;
    }
}

/**
 * @param {import("../../entities/map/ValetudoMap")} currentMap
 * @param {any} positions
 * @param {{x:number,y:number,angle:number}|null} robotPose
 * @param {Array<{x:number,y:number}>} [tracePathPointsMm]
 * @returns {import("../../entities/map/ValetudoMap")|null}
 */
function rebuildEntitiesOnlyMap(currentMap, positions, robotPose, tracePathPointsMm) {
    const transform = currentMap?.metaData?.ecovacsTransform;
    if (!transform) {
        return null;
    }
    const pixelSizeCm = Number(currentMap?.pixelSize ?? 0);
    if (!Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        return null;
    }

    const staticEntities = Array.isArray(currentMap.entities) ? currentMap.entities.filter(entity => {
        return entity?.type !== mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION &&
            entity?.type !== mapEntities.PointMapEntity.TYPE.ROBOT_POSITION &&
            entity?.type !== mapEntities.PathMapEntity.TYPE.PATH;
    }) : [];
    const dynamicEntities = [];

    const chargerPose = positions?.charger?.pose;
    const chargerPoint = chargerPose ? worldMmToMapPointCm(transform, Number(chargerPose.x), Number(chargerPose.y), pixelSizeCm) : null;
    if (chargerPoint) {
        dynamicEntities.push(new mapEntities.PointMapEntity({
            type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
            points: chargerPoint
        }));
    }

    if (robotPose) {
        const robotPoint = worldMmToMapPointCm(transform, Number(robotPose.x), Number(robotPose.y), pixelSizeCm);
        if (robotPoint) {
            dynamicEntities.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                points: robotPoint,
                metaData: {
                    angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                }
            }));
        }
    }

    const pathPointsCm = [];
    for (const point of (Array.isArray(tracePathPointsMm) ? tracePathPointsMm : [])) {
        const mapped = worldMmToMapPointCm(transform, Number(point.x), Number(point.y), pixelSizeCm);
        if (!mapped) {
            continue;
        }
        pathPointsCm.push(mapped[0], mapped[1]);
    }
    if (pathPointsCm.length >= 4) {
        dynamicEntities.push(new mapEntities.PathMapEntity({
            type: mapEntities.PathMapEntity.TYPE.PATH,
            points: pathPointsCm
        }));
    }

    if (dynamicEntities.length === 0) {
        return null;
    }
    if (areEntitySetsEquivalent(currentMap.entities, staticEntities.concat(dynamicEntities))) {
        return null;
    }

    return new mapEntities.ValetudoMap({
        size: currentMap.size,
        pixelSize: currentMap.pixelSize,
        layers: currentMap.layers,
        entities: staticEntities.concat(dynamicEntities),
        metaData: currentMap.metaData
    });
}

/**
 * @param {any} transform
 * @param {number} worldXmm
 * @param {number} worldYmm
 * @param {number} pixelSizeCm
 * @returns {Array<number>|null}
 */
function worldMmToMapPointCm(transform, worldXmm, worldYmm, pixelSizeCm) {
    if (!Number.isFinite(worldXmm) || !Number.isFinite(worldYmm)) {
        return null;
    }

    if (transform.type === "rooms") {
        const minX = Number(transform.minX);
        const maxY = Number(transform.maxY);
        const marginCm = Number(transform.marginCm);
        if (!Number.isFinite(minX) || !Number.isFinite(maxY) || !Number.isFinite(marginCm)) {
            return null;
        }
        const xCm = Math.round(worldXmm / 10);
        const yCm = Math.round(worldYmm / 10);
        const shiftedX = xCm - minX + marginCm;
        const shiftedY = maxY - yCm + marginCm;
        const gridX = Math.floor(shiftedX / pixelSizeCm);
        const gridY = Math.floor(shiftedY / pixelSizeCm);

        return [gridX * pixelSizeCm, gridY * pixelSizeCm];
    }

    if (transform.type === "script") {
        const mapWidthPx = Number(transform.mapWidthPx);
        const mapHeightPx = Number(transform.mapHeightPx);
        const mmPerPixel = Number(transform.mmPerPixel);
        if (!Number.isFinite(mapWidthPx) || !Number.isFinite(mapHeightPx) || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
            return null;
        }
        const cx = mapWidthPx / 2.0;
        const cy = mapHeightPx / 2.0;
        const x = clampInt(Math.round(cx + (worldXmm / mmPerPixel)), 0, mapWidthPx - 1);
        const y = clampInt(Math.round(cy - (worldYmm / mmPerPixel)), 0, mapHeightPx - 1);

        return [x * pixelSizeCm, y * pixelSizeCm];
    }

    return null;
}

/**
 * @param {any} transform
 * @param {number} mapXcm
 * @param {number} mapYcm
 * @param {number} pixelSizeCm
 * @returns {{x:number,y:number}|null}
 */
function mapCmToWorldMm(transform, mapXcm, mapYcm, pixelSizeCm) {
    if (!Number.isFinite(mapXcm) || !Number.isFinite(mapYcm) || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        return null;
    }

    if (transform.type === "rooms") {
        const minX = Number(transform.minX);
        const maxY = Number(transform.maxY);
        const marginCm = Number(transform.marginCm);
        if (!Number.isFinite(minX) || !Number.isFinite(maxY) || !Number.isFinite(marginCm)) {
            return null;
        }
        const gridX = Math.round(mapXcm / pixelSizeCm);
        const gridY = Math.round(mapYcm / pixelSizeCm);
        const xCm = gridX * pixelSizeCm + minX - marginCm;
        const yCm = maxY + marginCm - (gridY * pixelSizeCm);

        return {
            x: Math.round(xCm * 10),
            y: Math.round(yCm * 10)
        };
    }

    if (transform.type === "script") {
        const mapWidthPx = Number(transform.mapWidthPx);
        const mapHeightPx = Number(transform.mapHeightPx);
        const mmPerPixel = Number(transform.mmPerPixel);
        if (!Number.isFinite(mapWidthPx) || !Number.isFinite(mapHeightPx) || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
            return null;
        }
        const cx = mapWidthPx / 2.0;
        const cy = mapHeightPx / 2.0;
        const xPx = mapXcm / pixelSizeCm;
        const yPx = mapYcm / pixelSizeCm;

        return {
            x: Math.round((xPx - cx) * mmPerPixel),
            y: Math.round((cy - yPx) * mmPerPixel)
        };
    }

    return null;
}

/**
 * @param {any} transform
 * @param {number} pixelSizeCm
 * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
 * @returns {Array<any>}
 */
function buildRestrictionEntities(transform, pixelSizeCm, virtualWalls) {
    /** @type {Array<any>} */
    const entitiesOut = [];
    for (const wall of (Array.isArray(virtualWalls) ? virtualWalls : [])) {
        const pointsCm = (Array.isArray(wall.dots) ? wall.dots : []).map(dot => {
            return worldMmToMapPointCm(transform, Number(dot?.[0]), Number(dot?.[1]), pixelSizeCm);
        }).filter(Boolean);
        if (pointsCm.length < 2) {
            continue;
        }
        const flattened = pointsCm.flat();
        if (pointsCm.length >= 3) {
            const xs = pointsCm.map(point => point[0]);
            const ys = pointsCm.map(point => point[1]);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
                continue;
            }
            const normalizedRect = [
                minX, minY,
                maxX, minY,
                maxX, maxY,
                minX, maxY
            ];
            entitiesOut.push(new mapEntities.PolygonMapEntity({
                type: wall.type === 1 ?
                    mapEntities.PolygonMapEntity.TYPE.NO_MOP_AREA :
                    mapEntities.PolygonMapEntity.TYPE.NO_GO_AREA,
                points: normalizedRect
            }));
        } else {
            entitiesOut.push(new mapEntities.LineMapEntity({
                type: mapEntities.LineMapEntity.TYPE.VIRTUAL_WALL,
                points: flattened
            }));
        }
    }

    return entitiesOut;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }

    return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * @param {{worktype:number,state:number,workcause:number}|null|undefined} workState
 * @param {{isOnCharger:number,chargeState:number}|null|undefined} chargeState
 * @returns {string}
 */
function determineRobotStatus(workState, chargeState) {
    const onCharger = Number(chargeState?.isOnCharger) > 0;
    if (onCharger) {
        return stateAttrs.StatusStateAttribute.VALUE.DOCKED;
    }

    if (workState) {
        if (workState.state === WORK_STATE.PAUSED) {
            return stateAttrs.StatusStateAttribute.VALUE.PAUSED;
        }
        if (workState.state === WORK_STATE.RUNNING) {
            if (workState.worktype === WORK_TYPE.RETURN) {
                return stateAttrs.StatusStateAttribute.VALUE.RETURNING;
            }
            if (workState.worktype === WORK_TYPE.REMOTE_CONTROL) {
                return stateAttrs.StatusStateAttribute.VALUE.MANUAL_CONTROL;
            }
            if (workState.worktype === WORK_TYPE.GOTO) {
                return stateAttrs.StatusStateAttribute.VALUE.MOVING;
            }

            return stateAttrs.StatusStateAttribute.VALUE.CLEANING;
        }
    }

    return stateAttrs.StatusStateAttribute.VALUE.IDLE;
}

/**
 * @param {string} statusValue
 * @returns {string}
 */
function statusToDockStatus(statusValue) {
    if (statusValue === stateAttrs.StatusStateAttribute.VALUE.CLEANING) {
        return stateAttrs.DockStatusStateAttribute.VALUE.CLEANING;
    }
    if (statusValue === stateAttrs.StatusStateAttribute.VALUE.PAUSED) {
        return stateAttrs.DockStatusStateAttribute.VALUE.PAUSE;
    }

    return stateAttrs.DockStatusStateAttribute.VALUE.IDLE;
}

/**
 * @param {number} level
 * @param {number} isSilent
 * @returns {{type:string,value:string,customValue?:number}}
 */
function fanLevelToPresetValue(level, isSilent) {
    const fanLevel = Number(level);
    const silent = Number(isSilent) > 0;
    const presetType = stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED;
    if (silent) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.OFF
        };
    }
    if (fanLevel === 0) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW
        };
    }
    if (fanLevel === 1) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH
        };
    }
    if (fanLevel === 2) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX
        };
    }

    return {
        type: presetType,
        value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.CUSTOM,
        customValue: Number.isFinite(fanLevel) ? fanLevel : 0
    };
}

/**
 * @param {number} level
 * @returns {{type:string,value:string,customValue?:number}}
 */
function waterLevelToPresetValue(level) {
    const waterLevel = Number(level);
    const presetType = stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE;
    if (waterLevel === 0) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW
        };
    }
    if (waterLevel === 1) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM
        };
    }
    if (waterLevel === 2) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH
        };
    }
    if (waterLevel === 3) {
        return {
            type: presetType,
            value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX
        };
    }

    return {
        type: presetType,
        value: stateAttrs.PresetSelectionStateAttribute.INTENSITY.CUSTOM,
        customValue: Number.isFinite(waterLevel) ? waterLevel : 0
    };
}

/**
 * @param {Array<any>} before
 * @param {Array<any>} after
 * @returns {boolean}
 */
function areEntitySetsEquivalent(before, after) {
    try {
        return JSON.stringify(before ?? []) === JSON.stringify(after ?? []);
    } catch (e) {
        return false;
    }
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function estimateMapPayloadBytes(map) {
    try {
        return Buffer.byteLength(JSON.stringify(map), "utf8");
    } catch (e) {
        return -1;
    }
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @param {string} layerType
 * @returns {number}
 */
function getLayerPixelCountByType(map, layerType) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers
        .filter(layer => layer?.type === layerType)
        .reduce((sum, layer) => {
            const px = Number(layer?.dimensions?.pixelCount ?? 0);

            return sum + (Number.isFinite(px) ? px : 0);
        }, 0);
}
