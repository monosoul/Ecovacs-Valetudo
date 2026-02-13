const MapLayer = require("../../../entities/map/MapLayer");
const MapSegmentationCapability = require("../../../core/capabilities/MapSegmentationCapability");
const ValetudoMapSegment = require("../../../entities/core/ValetudoMapSegment");

/**
 * @extends MapSegmentationCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsMapSegmentationCapability extends MapSegmentationCapability {
    /**
     * @returns {Promise<Array<import("../../../entities/core/ValetudoMapSegment")>>}
     */
    async getSegments() {
        return this.robot.state.map.layers
            .filter(layer => {
                return layer.type === MapLayer.TYPE.SEGMENT;
            })
            .map(layer => {
                let id = layer.metaData.segmentId;
                if (typeof id === "number") {
                    id = id.toString();
                }

                return new ValetudoMapSegment({
                    id: id,
                    name: layer.metaData.name,
                    material: layer.metaData.material,
                    metaData: {
                        roomCleaningPreferences: layer.metaData.roomCleaningPreferences ?? null
                    }
                });
            });
    }

    /**
     * @param {string} segmentId
     * @param {{suction: number, water: number, times: number}} preferences
     * @returns {Promise<void>}
     */
    async setRoomCleaningPreferences(segmentId, preferences) {
        const roomId = Number.parseInt(segmentId, 10);
        if (!Number.isInteger(roomId) || roomId < 0 || roomId > 255) {
            throw new Error(`Invalid Ecovacs room id: ${segmentId}`);
        }
        const mapId = this.robot.getActiveMapId();

        await this.robot.rosFacade.setRoomCleaningPreferences(
            mapId,
            roomId,
            preferences.times,
            preferences.water,
            preferences.suction
        );

        // Trigger a map poll so the UI reflects updated preferences
        this.robot.pollMap();
    }

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
            customOrderSupport: false,
            roomCleaningPreferencesSupport: {
                enabled: true
            }
        };
    }
}

module.exports = EcovacsMapSegmentationCapability;
