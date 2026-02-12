const CombinedVirtualRestrictionsCapability = require("../../../core/capabilities/CombinedVirtualRestrictionsCapability");
const Logger = require("../../../Logger");
const ValetudoRestrictedZone = require("../../../entities/core/ValetudoRestrictedZone");
const ValetudoVirtualRestrictions = require("../../../entities/core/ValetudoVirtualRestrictions");

/**
 * @extends CombinedVirtualRestrictionsCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsCombinedVirtualRestrictionsCapability extends CombinedVirtualRestrictionsCapability {
    constructor(options) {
        super(Object.assign({}, options, {
            supportedRestrictedZoneTypes: [
                ValetudoRestrictedZone.TYPE.REGULAR,
                ValetudoRestrictedZone.TYPE.MOP
            ]
        }));
    }

    /**
     * @returns {Promise<import("../../../entities/core/ValetudoVirtualRestrictions")>}
     */
    async getVirtualRestrictions() {
        const restrictedZones = [];
        const mapId = requireActiveMapId(this.robot.getActiveMapId());
        const walls = await this.robot.rosFacade.getVirtualWalls(mapId);
        Logger.debug(`Ecovacs restrictions refresh: mapId=${mapId} walls=${walls.length}`);
        for (const wall of walls) {
            const mapped = (Array.isArray(wall.dots) ? wall.dots : []).map(dot => {
                return this.robot.worldPointToMap({x: Number(dot[0]), y: Number(dot[1])});
            }).filter(point => {
                return point && Number.isFinite(point.x) && Number.isFinite(point.y);
            });
            if (mapped.length < 2) {
                continue;
            }
            const xs = mapped.map(point => point.x);
            const ys = mapped.map(point => point.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
                continue;
            }
            restrictedZones.push(new ValetudoRestrictedZone({
                points: {
                    pA: {x: minX, y: minY},
                    pB: {x: maxX, y: minY},
                    pC: {x: maxX, y: maxY},
                    pD: {x: minX, y: maxY}
                },
                type: Number(wall.type) === 1 ? ValetudoRestrictedZone.TYPE.MOP : ValetudoRestrictedZone.TYPE.REGULAR
            }));
        }

        return new ValetudoVirtualRestrictions({
            virtualWalls: [],
            restrictedZones: restrictedZones
        });
    }

    /**
     * @param {import("../../../entities/core/ValetudoVirtualRestrictions")} virtualRestrictions
     * @returns {Promise<void>}
     */
    async setVirtualRestrictions(virtualRestrictions) {
        if (Array.isArray(virtualRestrictions.virtualWalls) && virtualRestrictions.virtualWalls.length > 0) {
            Logger.warn(
                `Ecovacs restrictions save: ignoring ${virtualRestrictions.virtualWalls.length} line walls` +
                " because firmware supports only rectangular zones"
            );
        }

        const restrictedZones = Array.isArray(virtualRestrictions.restrictedZones) ? virtualRestrictions.restrictedZones : [];
        const mapId = requireActiveMapId(this.robot.getActiveMapId());
        Logger.debug(
            `Ecovacs restrictions save: mapId=${mapId} zones=${restrictedZones.length}`
        );
        const existing = await this.robot.rosFacade.getVirtualWalls(mapId);
        for (const wall of existing) {
            try {
                const result = await this.robot.rosFacade.deleteVirtualWall(mapId, wall.vwid);
                ensureResultOk("deleteVirtualWall", result);
            } catch (e) {
                // Continue best-effort deletion for idempotent full replace flow.
            }
        }

        let nextId = 1;
        for (const zone of restrictedZones) {
            const rect = this.robot.mapZoneToWorldRect(zone);
            if (zone.type === ValetudoRestrictedZone.TYPE.MOP) {
                const result = await this.robot.rosFacade.addNoMopZone(mapId, nextId++, rect);
                ensureResultOk("addNoMopZone", result);
            } else {
                const result = await this.robot.rosFacade.addVirtualWallRect(mapId, nextId++, 0, rect);
                ensureResultOk("addVirtualBoundary", result);
            }
        }

        this.robot.pollMap();
    }
}

/**
 * @param {string} action
 * @param {number} result
 */
function ensureResultOk(action, result) {
    if (Number(result) !== 0) {
        throw new Error(`${action} failed with result=${result}`);
    }
}

/**
 * @param {number} mapId
 * @returns {number}
 */
function requireActiveMapId(mapId) {
    if (!Number.isInteger(mapId) || mapId === 0) {
        throw new Error("Active map id is not initialized yet. Wait for map update and try again.");
    }

    return mapId >>> 0;
}

module.exports = EcovacsCombinedVirtualRestrictionsCapability;
