const Logger = require("../../../Logger");
const MapSegmentRenameCapability = require("../../../core/capabilities/MapSegmentRenameCapability");
const {ROOM_LABEL_NAMES_BY_ID, labelIdFromName} = require("../RoomLabels");

/**
 * @extends MapSegmentRenameCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsMapSegmentRenameCapability extends MapSegmentRenameCapability {
    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {string} name
     * @returns {Promise<void>}
     */
    async renameSegment(segment, name) {
        const mapId = this.robot.getActiveMapId();
        if (!Number.isInteger(mapId) || mapId === 0) {
            throw new Error("Active map id is not initialized yet. Wait for map update and try again.");
        }

        const roomId = Number.parseInt(String(segment.id), 10);
        if (!Number.isInteger(roomId) || roomId < 0) {
            throw new Error(`Invalid Ecovacs room id: ${segment.id}`);
        }

        const labelId = labelIdFromName(name);

        const currentSegments = this.robot.state?.map?.getSegments?.() ?? [];
        Logger.debug(
            `MapSegmentRename: segment.id=${segment.id} roomId=${roomId} mapId=${mapId} ` +
            `labelId=${labelId} name=${name} ` +
            `currentSegments=[${currentSegments.map(s => `{id=${s.id},name=${s.name}}`).join(", ")}]`
        );

        const response = await this.robot.rosFacade.setRoomLabel(mapId, roomId, labelId);
        Logger.debug(`MapSegmentRename: response=${JSON.stringify(response)}`);
        if (Number(response?.result) !== 0) {
            throw new Error(`setRoomLabel failed with result=${response?.result}`);
        }

        this.robot.pollMap();
    }

    /**
     * @returns {{presetNames:Array<string>}}
     */
    getProperties() {
        return {
            presetNames: Object.values(ROOM_LABEL_NAMES_BY_ID)
        };
    }
}

module.exports = EcovacsMapSegmentRenameCapability;
