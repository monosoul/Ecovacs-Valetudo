const MapSegmentationCapability = require("../../../core/capabilities/MapSegmentationCapability");

/**
 * @extends MapSegmentationCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsMapSegmentationCapability extends MapSegmentationCapability {
    /**
     * @param {Array<import("../../../entities/core/ValetudoMapSegment")>} segments
     * @returns {Promise<void>}
     */
    async executeSegmentAction(segments) {
        const roomIds = segments.map(segment => {
            const id = Number.parseInt(segment.id, 10);
            if (!Number.isInteger(id) || id < 0 || id > 255) {
                throw new Error(`Invalid Ecovacs room id: ${segment.id}`);
            }

            return id;
        });
        if (roomIds.length === 0) {
            throw new Error("No room ids provided for segment cleaning");
        }

        await this.robot.rosFacade.startRoomClean(roomIds);
    }

    /**
     * @returns {import("../../../core/capabilities/MapSegmentationCapability").MapSegmentationCapabilityProperties}
     */
    getProperties() {
        return {
            iterationCount: {
                min: 1,
                max: 1
            },
            customOrderSupport: false
        };
    }
}

module.exports = EcovacsMapSegmentationCapability;
