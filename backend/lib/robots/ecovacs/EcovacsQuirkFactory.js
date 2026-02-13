const Quirk = require("../../core/Quirk");

class EcovacsQuirkFactory {
    /**
     * @param {object} options
     * @param {import("./EcovacsT8AiviValetudoRobot")} options.robot
     */
    constructor(options) {
        this.robot = options.robot;
    }

    /**
     * @param {string} id
     * @returns {import("../../core/Quirk")}
     */
    getQuirk(id) {
        switch (id) {
            case EcovacsQuirkFactory.KNOWN_QUIRKS.AUTO_COLLECT:
                return new Quirk({
                    id: id,
                    title: "Auto collect",
                    description: "Enable or disable automatic dust collection.",
                    options: ["on", "off"],
                    getter: async () => {
                        return await this.robot.rosFacade.getAutoCollectEnabled();
                    },
                    setter: async (value) => {
                        if (value !== "on" && value !== "off") {
                            throw new Error(`Received invalid value ${value}`);
                        }
                        const result = await this.robot.rosFacade.setAutoCollectEnabled(value);
                        if (Number(result) !== 0) {
                            throw new Error(`setAutoCollectEnabled failed with result=${result}`);
                        }
                    }
                });
            case EcovacsQuirkFactory.KNOWN_QUIRKS.ROOM_CLEANING_PREFERENCES:
                return new Quirk({
                    id: id,
                    title: "Per-room cleaning preferences",
                    description: "Enable or disable per-room cleaning preferences used by the Ecovacs app.",
                    options: ["on", "off"],
                    getter: async () => {
                        return await this.robot.rosFacade.getRoomPreferencesEnabled();
                    },
                    setter: async (value) => {
                        if (value !== "on" && value !== "off") {
                            throw new Error(`Received invalid value ${value}`);
                        }
                        const result = await this.robot.rosFacade.setRoomPreferencesEnabled(value);
                        if (Number(result) !== 0) {
                            throw new Error(`setRoomPreferencesEnabled failed with result=${result}`);
                        }
                    }
                });
            default:
                throw new Error(`There's no quirk with id ${id}`);
        }
    }
}

EcovacsQuirkFactory.KNOWN_QUIRKS = {
    AUTO_COLLECT: "f2925e3e-0c6f-45d5-8a72-5ccfd90b0a1e",
    ROOM_CLEANING_PREFERENCES: "53e45530-1436-4016-b79a-8b44f95b36d5"
};

module.exports = EcovacsQuirkFactory;
