const entities = require("../../entities");

const stateAttrs = entities.state.attributes;

const REMOTE_MOVE_MVA_CUSTOM = 9;
const REMOTE_MOVE_FORWARD = 0;
const REMOTE_MOVE_BACKWARD = 1;
const REMOTE_MOVE_STOP = 2;
const REMOTE_TURN_W = 87;

const WORK_STATE = Object.freeze({
    IDLE: 0,
    RUNNING: 1,
    PAUSED: 2
});

const WORK_TYPE = Object.freeze({
    AUTO_CLEAN: 0,
    AREA_CLEAN: 1,
    CUSTOM_CLEAN: 2,
    RETURN: 5,
    GOTO: 6,
    IDLE: 7,
    REMOTE_CONTROL: 9,
    AUTO_COLLECT_DIRT: 13
});

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

module.exports = {
    REMOTE_MOVE_BACKWARD: REMOTE_MOVE_BACKWARD,
    REMOTE_MOVE_FORWARD: REMOTE_MOVE_FORWARD,
    REMOTE_MOVE_MVA_CUSTOM: REMOTE_MOVE_MVA_CUSTOM,
    REMOTE_MOVE_STOP: REMOTE_MOVE_STOP,
    REMOTE_TURN_W: REMOTE_TURN_W,
    WORK_STATE: WORK_STATE,
    WORK_TYPE: WORK_TYPE,
    determineRobotStatus: determineRobotStatus,
    fanLevelToPresetValue: fanLevelToPresetValue,
    statusToDockStatus: statusToDockStatus,
    waterLevelToPresetValue: waterLevelToPresetValue,
};
