const capabilities = require("./capabilities");
const EcovacsLifespanService = require("./ros/services/EcovacsLifespanService");
const EcovacsMapService = require("./ros/services/EcovacsMapService");
const EcovacsPositionService = require("./ros/services/EcovacsPositionService");
const EcovacsQuirkFactory = require("./EcovacsQuirkFactory");
const EcovacsRemoteSessionService = require("./ros/services/EcovacsRemoteSessionService");
const EcovacsRuntimeStateCache = require("./EcovacsRuntimeStateCache");
const EcovacsRuntimeStateService = require("./ros/services/EcovacsRuntimeStateService");
const EcovacsSettingService = require("./ros/services/EcovacsSettingService");
const EcovacsSoundService = require("./ros/services/EcovacsSoundService");
const EcovacsSpotAreaService = require("./ros/services/EcovacsSpotAreaService");
const EcovacsStatisticsService = require("./ros/services/EcovacsStatisticsService");
const EcovacsTraceService = require("./ros/services/EcovacsTraceService");
const EcovacsVirtualWallService = require("./ros/services/EcovacsVirtualWallService");
const EcovacsWorkManageService = require("./ros/services/EcovacsWorkManageService");
const entities = require("../../entities");
const fs = require("fs");
const Logger = require("../../Logger");
const mapEntities = require("../../entities/map");
const MdsctlClient = require("./ros/services/MdsctlClient");
const QuirksCapability = require("../../core/capabilities/QuirksCapability");
const RosMasterXmlRpcClient = require("./ros/core/RosMasterXmlRpcClient");
const ValetudoRobot = require("../../core/ValetudoRobot");
const {
    determineRobotStatus,
    fanLevelToPresetValue,
    statusToDockStatus,
    waterLevelToPresetValue,
} = require("./EcovacsStateMapping");
const {alertTypeName, findMostSevereErrorAlert, mapAlertToRobotError} = require("./EcovacsAlertMapping");
const {buildMap, rebuildEntitiesOnlyMap} = require("./map/EcovacsMapBuilder");
const {clampInt} = require("./map/EcovacsMapTransforms");
const {decodeCompressedMapResponse} = require("./map/EcovacsCompressedMapDecoder");
const {decodeTraceRawHexToWorldMmPoints} = require("./map/EcovacsTraceDecoder");
const {formatMapStats, getLayerPixelCountByType, getTotalLayerPixelCount, hasChargerEntity, hasRobotEntity} = require("./map/EcovacsMapStats");

const stateAttrs = entities.state.attributes;
const DEFAULT_RUNTIME_STATE_CACHE_PATH = "/tmp/valetudo_ecovacs_runtime_state.json";

class EcovacsT8AiviValetudoRobot extends ValetudoRobot {
    /**
     * @param {object} options
     * @param {import("../../Configuration")} options.config
     * @param {import("../../ValetudoEventStore")} options.valetudoEventStore
     */
    constructor(options) {
        super(options);

        const implementationSpecificConfig = options.config.get("robot")?.implementationSpecificConfig ?? {};

        this.detailedMapMaxLayerPixels = implementationSpecificConfig.detailedMapMaxLayerPixels ?? 120_000;
        this.detailedMapMinFloorPixels = implementationSpecificConfig.detailedMapMinFloorPixels ?? 1_000;
        this.detailedMapRefreshIntervalMs = implementationSpecificConfig.detailedMapRefreshIntervalMs ?? 120_000;
        this.detailedMapRotationDegrees = implementationSpecificConfig.detailedMapRotationDegrees ?? 270;
        this.detailedMapWorldMmPerPixel = implementationSpecificConfig.detailedMapWorldMmPerPixel ?? 50;
        this.livePositionPollIntervalMs = implementationSpecificConfig.livePositionPollIntervalMs ?? 1500;
        this.livePositionCommandTimeoutMs = implementationSpecificConfig.livePositionCommandTimeoutMs ?? 4000;
        this.powerStatePollIntervalMs = implementationSpecificConfig.powerStatePollIntervalMs ?? 3000;
        this.cleaningSettingsPollIntervalMs = implementationSpecificConfig.cleaningSettingsPollIntervalMs ?? 30_000;
        this.powerStateStaleAfterMs = implementationSpecificConfig.powerStateStaleAfterMs ?? 300_000;
        this.workStateStaleAfterMs = implementationSpecificConfig.workStateStaleAfterMs ?? 20_000;
        this.tracePathEnabled = implementationSpecificConfig.tracePathEnabled ?? true;
        this.tracePointUnitMm = implementationSpecificConfig.tracePointUnitMm ?? 10;
        this.tracePathMaxPoints = implementationSpecificConfig.tracePathMaxPoints ?? 2000;
        this.traceTailEntries = implementationSpecificConfig.traceTailEntries ?? 1;
        this.rosDebug = implementationSpecificConfig.rosDebug ?? true;
        this.manualControlSessionCode = implementationSpecificConfig.manualControlSessionCode;
        this.manualControlActiveFlag = false;
        this.currentWorkType = null;
        this.lastRobotPose = null;
        this.cachedCompressedMap = null;
        this.cachedCompressedMapAt = 0;
        this.livePositionPollTimer = null;
        this.livePositionPollInFlight = false;
        this.powerStatePollTimer = null;
        this.cleaningSettingsPollTimer = null;
        this.runtimeStateCache = new EcovacsRuntimeStateCache({
            cachePath: implementationSpecificConfig.runtimeStateCachePath ?? DEFAULT_RUNTIME_STATE_CACHE_PATH,
            writeMinIntervalMs: implementationSpecificConfig.runtimeStateCacheWriteMinIntervalMs ?? 5000
        });
        this.livePositionRefreshCounter = 0;
        this.tracePathPointsMm = [];
        this.lastTraceEndIdx = -1;
        this.lastTraceMapId = null;
        /** @type {Object<string, {suction: number, water: number, times: number, sequence: number}>} */
        this.cachedRoomCleaningPreferences = {};
        this.activeMapId = null;
        this.tracePathWarningShown = false;
        const masterClient = new RosMasterXmlRpcClient({
            masterUri: implementationSpecificConfig.rosMasterUri ?? process.env.ROS_MASTER_URI ?? "http://127.0.0.1:11311",
            timeoutMs: implementationSpecificConfig.rosConnectTimeoutMs ?? 4_000
        });
        const rosOptions = {
            masterClient: masterClient,
            callerId: implementationSpecificConfig.rosCallerId ?? process.env.ROS_CALLER_ID ?? "/ROSNODE",
            connectTimeoutMs: implementationSpecificConfig.rosConnectTimeoutMs ?? 4_000,
            callTimeoutMs: implementationSpecificConfig.rosCallTimeoutMs ?? 6_000,
            debug: this.rosDebug,
            onWarn: (msg, err) => Logger.debug(`Ecovacs ROS: ${msg}: ${err ?? ""}`)
        };
        this.mapService = new EcovacsMapService(rosOptions);
        this.spotAreaService = new EcovacsSpotAreaService(rosOptions);
        this.virtualWallService = new EcovacsVirtualWallService(rosOptions);
        this.positionService = new EcovacsPositionService(rosOptions);
        this.traceService = new EcovacsTraceService(rosOptions);
        this.workManageService = new EcovacsWorkManageService(rosOptions);
        this.settingService = new EcovacsSettingService(rosOptions);
        this.lifespanService = new EcovacsLifespanService(rosOptions);
        this.statisticsService = new EcovacsStatisticsService(rosOptions);
        this.runtimeStateService = new EcovacsRuntimeStateService(rosOptions);
        this.mdsctlClient = new MdsctlClient({
            binaryPath: implementationSpecificConfig.mdsctlBinaryPath,
            socketPath: implementationSpecificConfig.mdsctlSocketPath,
            timeoutMs: implementationSpecificConfig.mdsctlTimeoutMs ?? 2_000
        });
        this.remoteSessionService = new EcovacsRemoteSessionService({mdsctlClient: this.mdsctlClient});
        this.soundService = new EcovacsSoundService({mdsctlClient: this.mdsctlClient});

        this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
            value: stateAttrs.DockStatusStateAttribute.VALUE.IDLE
        }));
        const cachedChargeState = this.runtimeStateCache.data?.chargeState;
        const isCachedDocked = Boolean(
            cachedChargeState &&
            Number.isFinite(Number(cachedChargeState.isOnCharger)) &&
            Number(cachedChargeState.isOnCharger) > 0
        );
        const initialStatus = isCachedDocked ?
            stateAttrs.StatusStateAttribute.VALUE.DOCKED :
            stateAttrs.StatusStateAttribute.VALUE.IDLE;
        const cachedBatteryLevel = Number(this.runtimeStateCache.data?.battery?.level);
        const cachedBatteryFlag = this.runtimeStateCache.data?.battery?.flag;
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

        const cachedPose = this.runtimeStateCache.data?.robotPose;
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
        this.registerCapability(new capabilities.EcovacsTotalStatisticsCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsCurrentStatisticsCapability({robot: this}));

        const quirkFactory = new EcovacsQuirkFactory({
            robot: this
        });
        this.registerCapability(new QuirksCapability({
            robot: this,
            quirks: [
                quirkFactory.getQuirk(EcovacsQuirkFactory.KNOWN_QUIRKS.AUTO_COLLECT),
                quirkFactory.getQuirk(EcovacsQuirkFactory.KNOWN_QUIRKS.ROOM_CLEANING_PREFERENCES)
            ]
        }));
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

        // Start ROS services and fetch initial map ID before starting polls
        void Promise.all([
            this.positionService.startup(),
            this.runtimeStateService.startup(),
            this.statisticsService.startup()
        ]).then(async () => {
            try {
                Logger.debug("Ecovacs: fetching initial active map ID");
                const activeMapId = await this.mapService.getActiveMapId();
                if (activeMapId !== null) {
                    this.activeMapId = activeMapId;
                    Logger.debug(`Ecovacs: initial active map ID is ${activeMapId}`);
                } else {
                    Logger.warn("Ecovacs: no active map ID available at startup");
                }
            } catch (e) {
                Logger.warn("Ecovacs: failed to fetch initial active map ID", e);
            }

            // Start all timers after we have the initial map ID
            setTimeout(() => {
                this.pollMap();
            }, 2000);

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
        }).catch((e) => {
            Logger.error("Ecovacs: ROS services startup failed, timers not started", e);
        });
    }

    /**
     * @returns {Promise<void>}
     */
    async executeMapPoll() {
        const pollStartedAt = Date.now();

        try {
            const requestedMapId = this.getActiveMapId();
            Logger.debug(`Ecovacs map poll: fetching rooms (mapId=${requestedMapId})`);
            const roomDump = await this.spotAreaService.getRooms(requestedMapId);

            // Update activeMapId from the rooms response
            if (Number.isInteger(roomDump?.header?.mapid)) {
                const responseMapId = roomDump.header.mapid >>> 0;
                if (this.activeMapId !== responseMapId) {
                    Logger.info(`Ecovacs: active map ID changed from ${this.activeMapId} to ${responseMapId}`);
                    this.activeMapId = responseMapId;
                }
            }
            const mapId = this.getActiveMapId();

            if (!Array.isArray(roomDump.rooms) || roomDump.rooms.length === 0) {
                throw new Error("No room polygons returned by ManipulateSpotArea");
            }
            for (const room of roomDump.rooms) {
                if (room.preference_suction !== undefined) {
                    this.cachedRoomCleaningPreferences[String(room.index)] = {
                        suction: room.preference_suction,
                        water: room.preference_water,
                        times: room.preference_times,
                        sequence: room.preference_sequence ?? 0,
                    };
                }
            }
            Logger.debug(`Ecovacs map poll: rooms fetched (${roomDump.rooms.length})`);

            let positions = undefined;
            try {
                positions = await this.positionService.getPositions(mapId);
                Logger.debug("Ecovacs map poll: positions fetched");
            } catch (e) {
                // Positions are optional for this first map integration step.
                Logger.warn("Ecovacs map poll: positions unavailable", e?.message ?? e);
            }
            let virtualWalls = [];
            try {
                virtualWalls = await this.virtualWallService.getVirtualWalls(mapId);
                Logger.debug(`Ecovacs map poll: virtual walls fetched (${virtualWalls.length})`);
            } catch (e) {
                Logger.warn("Ecovacs map poll: virtual walls unavailable", e?.message ?? e);
            }

            this.updateRobotPoseFromPositions(positions);
            const robotPoseSnapshot = this.getCurrentRobotPoseOrNull();

            let compressedMap = this.cachedCompressedMap;
            const cacheAgeMs = Date.now() - this.cachedCompressedMapAt;
            const cacheValid = compressedMap !== null && cacheAgeMs >= 0 && cacheAgeMs < this.detailedMapRefreshIntervalMs;
            if (cacheValid) {
                Logger.debug(`Ecovacs map poll: using cached compressed map (${cacheAgeMs}ms old)`);
            } else {
                Logger.debug("Ecovacs map poll: fetching compressed map");
                const compressedRaw = await this.mapService.getCompressedMap(mapId);

                // Update activeMapId from the compressed map response
                if (Number.isInteger(compressedRaw?.mapid)) {
                    const responseMapId = compressedRaw.mapid >>> 0;
                    if (this.activeMapId !== responseMapId) {
                        Logger.info(`Ecovacs: active map ID changed from ${this.activeMapId} to ${responseMapId} (from compressed map)`);
                        this.activeMapId = responseMapId;
                    }
                }

                Logger.debug("Ecovacs map poll: decoding compressed map submaps");
                compressedMap = decodeCompressedMapResponse(compressedRaw);
                this.cachedCompressedMap = compressedMap;
                this.cachedCompressedMapAt = Date.now();
                Logger.debug(
                    `Ecovacs map poll: decoded compressed map (${compressedMap.width}x${compressedMap.height})`
                );
            }
            const map = buildMap(
                roomDump.rooms,
                positions,
                robotPoseSnapshot,
                compressedMap,
                virtualWalls,
                {
                    rotationDegrees: this.detailedMapRotationDegrees,
                    worldMmPerPixel: this.detailedMapWorldMmPerPixel,
                    cachedRoomCleaningPreferences: this.cachedRoomCleaningPreferences,
                }
            );
            const mapWithEntities = rebuildEntitiesOnlyMap(
                map,
                positions,
                robotPoseSnapshot,
                this.tracePathPointsMm
            ) ?? map;
            const totalPixels = getTotalLayerPixelCount(map);
            const floorPixels = getLayerPixelCountByType(mapWithEntities, mapEntities.MapLayer.TYPE.FLOOR);
            if (this.rosDebug) {
                Logger.info(`Ecovacs map poll: map stats ${formatMapStats(mapWithEntities)}`);
            }
            Logger.debug(
                `Ecovacs entities: robot=${hasRobotEntity(mapWithEntities)} charger=${hasChargerEntity(mapWithEntities)}`
            );
            if (totalPixels > this.detailedMapMaxLayerPixels) {
                Logger.warn(
                    `Ecovacs map poll: map too large (${totalPixels} px > ${this.detailedMapMaxLayerPixels} px), skipping`
                );
                return;
            }
            if (floorPixels < this.detailedMapMinFloorPixels) {
                Logger.warn(
                    `Ecovacs map poll: floor too small (${floorPixels} px < ${this.detailedMapMinFloorPixels} px), skipping`
                );
                return;
            }
            this.state.map = mapWithEntities;
            this.emitMapUpdated();
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
        this.runtimeStateCache.shutdown();

        await Promise.all([
            this.mapService.shutdown(),
            this.spotAreaService.shutdown(),
            this.virtualWallService.shutdown(),
            this.positionService.shutdown(),
            this.traceService.shutdown(),
            this.workManageService.shutdown(),
            this.settingService.shutdown(),
            this.lifespanService.shutdown(),
            this.statisticsService.shutdown(),
            this.runtimeStateService.shutdown()
        ]);
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
            const positions = await this.positionService.getPositions(this.getActiveMapId());
            this.updateRobotPoseFromPositions(positions);
            if (this.tracePathEnabled) {
                try {
                    await this.updateTracePathFromService();
                } catch (e) {
                    if (!this.tracePathWarningShown) {
                        Logger.warn(
                            "Ecovacs trace: service call failed.",
                            e?.message ?? e
                        );
                        this.tracePathWarningShown = true;
                    } else if (this.rosDebug) {
                        Logger.debug(`Ecovacs trace: service call failed: ${e?.message ?? e}`);
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
            const workState = this.runtimeStateService.getRuntimeState()?.workState;
            const powerState = this.runtimeStateService.getPowerState();
            const battery = powerState?.battery;
            const chargeState = powerState?.chargeState;
            let stateChanged = false;

            if (workState && typeof workState.worktype === "number") {
                this.currentWorkType = workState.worktype;
            }

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

                if (previous?.level !== level || previous?.flag !== flag) {
                    stateChanged = true;
                }
                this.state.upsertFirstMatchingAttribute(new stateAttrs.BatteryStateAttribute({
                    level: level,
                    flag: flag
                }));
                this.runtimeStateCache.update({
                    battery: {
                        level: level,
                        flag: flag
                    }
                });
            }
            if (chargeState && typeof chargeState.isOnCharger === "number" && typeof chargeState.chargeState === "number") {
                this.runtimeStateCache.update({
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

            const triggeredAlerts = this.runtimeStateService.getTriggeredAlerts();
            const errorAlert = triggeredAlerts && triggeredAlerts.length > 0 ?
                findMostSevereErrorAlert(triggeredAlerts) :
                null;

            const previousStatus = this.state.getFirstMatchingAttributeByConstructor(stateAttrs.StatusStateAttribute);
            const previousStatusValue = previousStatus?.value;
            let statusValue;

            if (errorAlert) {
                statusValue = stateAttrs.StatusStateAttribute.VALUE.ERROR;
                if (previousStatusValue !== statusValue || previousStatus?.error?.vendorErrorCode !== String(errorAlert.type)) {
                    Logger.debug(
                        `Ecovacs alert error: type=${errorAlert.type} (${alertTypeName(errorAlert.type)})` +
                        ` (workState=${JSON.stringify(workState ?? null)}, chargeState=${JSON.stringify(chargeState ?? null)})`
                    );
                    stateChanged = true;
                }
                this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
                    value: statusValue,
                    flag: stateAttrs.StatusStateAttribute.FLAG.NONE,
                    error: mapAlertToRobotError(errorAlert.type)
                }));
            } else {
                statusValue = determineRobotStatus(workState, chargeState);
                if (previousStatusValue !== statusValue) {
                    Logger.debug(
                        `Ecovacs runtime status transition: ${previousStatusValue ?? "unknown"} -> ${statusValue}` +
                        ` (workState=${JSON.stringify(workState ?? null)}, chargeState=${JSON.stringify(chargeState ?? null)})`
                    );
                    stateChanged = true;
                }
                this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
                    value: statusValue,
                    flag: stateAttrs.StatusStateAttribute.FLAG.NONE
                }));
            }
            this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
                value: statusToDockStatus(statusValue)
            }));

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
                this.settingService.getFanMode(),
                this.settingService.getWaterLevel()
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
            this.runtimeStateCache.update({
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
        if (!Number.isInteger(this.activeMapId)) {
            throw new Error("Active map ID is not initialized. Wait for robot to be ready.");
        }
        return this.activeMapId >>> 0;
    }

    /**
     * @returns {Promise<void>}
     */
    async updateTracePathFromService() {
        const mapId = this.getActiveMapId();
        const trace = await this.traceService.getTraceLatest(mapId, this.traceTailEntries);
        if (trace === null) {
            // The trace service signals a reset (endIdx=0 or 0xFFFFFFFF).
            // Clear stale state so the next real endIdx is accepted.
            if (this.lastTraceEndIdx !== -1) {
                this.tracePathPointsMm = [];
                this.lastTraceEndIdx = -1;
                if (this.rosDebug) {
                    Logger.debug("Ecovacs trace: service signaled reset, cleared trace state");
                }
            }
            return;
        }
        const traceMapId = Number(trace.trace_mapid);
        const traceEndIdx = Number(trace.trace_end_idx);
        const rawHex = String(trace.trace_raw_hex ?? "");
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

module.exports = EcovacsT8AiviValetudoRobot;
