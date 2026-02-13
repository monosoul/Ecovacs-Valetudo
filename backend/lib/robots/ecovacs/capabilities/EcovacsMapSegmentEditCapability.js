const MapSegmentEditCapability = require("../../../core/capabilities/MapSegmentEditCapability");

/**
 * @extends MapSegmentEditCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsMapSegmentEditCapability extends MapSegmentEditCapability {
    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentA
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentB
     * @returns {Promise<void>}
     */
    async joinSegments(segmentA, segmentB) {
        const mapId = requireActiveMapId(this.robot.getActiveMapId());
        const roomIdA = parseRoomId(segmentA.id);
        const roomIdB = parseRoomId(segmentB.id);
        if (roomIdA === roomIdB) {
            throw new Error("Cannot merge the same room id");
        }

        const response = await this.robot.rosFacade.mergeRooms(mapId, [roomIdA, roomIdB]);
        ensureResultOk("mergeRooms", response?.result);

        this.robot.pollMap();
    }

    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {{x:number,y:number}} pA
     * @param {{x:number,y:number}} pB
     * @returns {Promise<void>}
     */
    async splitSegment(segment, pA, pB) {
        const mapId = requireActiveMapId(this.robot.getActiveMapId());
        const roomId = parseRoomId(segment.id);
        const worldA = this.robot.mapPointToWorld(pA);
        const worldB = this.robot.mapPointToWorld(pB);

        const response = await this.robot.rosFacade.splitRoom(mapId, roomId, [
            Number(worldA.x),
            Number(worldA.y),
            Number(worldB.x),
            Number(worldB.y)
        ]);
        ensureResultOk("splitRoom", response?.result);

        this.robot.pollMap();
    }
}

/**
 * @param {string|number} roomId
 * @returns {number}
 */
function parseRoomId(roomId) {
    const parsed = Number.parseInt(String(roomId), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid Ecovacs room id: ${roomId}`);
    }

    return parsed;
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

/**
 * @param {string} action
 * @param {number} result
 */
function ensureResultOk(action, result) {
    if (Number(result) !== 0) {
        throw new Error(`${action} failed with result=${result}`);
    }
}

module.exports = EcovacsMapSegmentEditCapability;
