const ZoneCleaningCapability = require("../../../core/capabilities/ZoneCleaningCapability");

/**
 * @extends ZoneCleaningCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsZoneCleaningCapability extends ZoneCleaningCapability {
    /**
     * @param {object} options
     * @param {Array<import("../../../entities/core/ValetudoZone")>} options.zones
     * @param {number} [options.iterations]
     * @returns {Promise<void>}
     */
    async start(options) {
        if (!Array.isArray(options?.zones) || options.zones.length === 0) {
            throw new Error("At least one zone is required");
        }
        if ((options.iterations ?? 1) !== 1) {
            throw new Error("Ecovacs custom area cleaning supports only one iteration");
        }

        const rects = options.zones.map(zone => {
            return this.robot.mapZoneToWorldRect(zone);
        });

        await this.robot.rosFacade.startCustomClean(rects);
    }

    /**
     * @returns {import("../../../core/capabilities/ZoneCleaningCapability").ZoneCleaningCapabilityProperties}
     */
    getProperties() {
        return {
            zoneCount: {
                min: 1,
                max: 5
            },
            iterationCount: {
                min: 1,
                max: 1
            }
        };
    }
}

module.exports = EcovacsZoneCleaningCapability;
