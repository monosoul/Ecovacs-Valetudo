const ValetudoRobotError = require("../../entities/core/ValetudoRobotError");
const {ALERT_TYPE} = require("./ros/core/TopicStateSubscriber");

/**
 * Alert types classified as errors (vs. warnings).
 * Only these will cause the robot state to transition to ERROR.
 * @type {Set<number>}
 */
const ERROR_ALERT_TYPES = new Set([
    ALERT_TYPE.FALL_ERROR,
    ALERT_TYPE.BRUSH_CURRENT_STATE_ERROR,
    ALERT_TYPE.SIDE_BRUSH_CURRENT_ERROR,
    ALERT_TYPE.LEFT_WHEEL_CURRENT_ERROR,
    ALERT_TYPE.RIGHT_WHEEL_CURRENT_ERROR,
    ALERT_TYPE.DOWNIN_ERROR,
    ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_ERROR,
    ALERT_TYPE.BUMP_LONG_TIMER_NO_TRIGE_ERROR,
    ALERT_TYPE.DEGREE_NO_CHANGE_ERROR,
    ALERT_TYPE.LEFT_WHEEL_SPEED_ERROR,
    ALERT_TYPE.RIGHT_WHEEL_SPEED_ERROR,
    ALERT_TYPE.FAN_SPEED_ERROR,
    ALERT_TYPE.ROBOT_STUCK_ERROR,
    ALERT_TYPE.LDS_ERROR,
    ALERT_TYPE.ULTRA_WATERBOX_ERROR,
]);

/**
 * Human-readable names for alert types.
 * @type {Object<number, string>}
 */
const ALERT_TYPE_NAMES = {
    [ALERT_TYPE.DIRT_BOX_STATE]: "Dustbin issue",
    [ALERT_TYPE.WATER_BOX_STATE]: "Water tank issue",
    [ALERT_TYPE.FALL_ERROR]: "Cliff sensor error",
    [ALERT_TYPE.BRUSH_CURRENT_STATE_ERROR]: "Main brush overcurrent",
    [ALERT_TYPE.SIDE_BRUSH_CURRENT_ERROR]: "Side brush overcurrent",
    [ALERT_TYPE.LEFT_WHEEL_CURRENT_ERROR]: "Left wheel overcurrent",
    [ALERT_TYPE.RIGHT_WHEEL_CURRENT_ERROR]: "Right wheel overcurrent",
    [ALERT_TYPE.DOWNIN_ERROR]: "Drop sensor error",
    [ALERT_TYPE.BRUSH_CURRENT_LARGE_CURRENT_WARNING]: "Main brush high current",
    [ALERT_TYPE.SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: "Side brush high current",
    [ALERT_TYPE.LEFT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: "Left side brush high current",
    [ALERT_TYPE.RIGHT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: "Right side brush high current",
    [ALERT_TYPE.FALL_STATE_WARNING]: "Cliff sensor warning",
    [ALERT_TYPE.LEFT_WHEEL_CURRENT_LARGE_CURRENT_WARNING]: "Left wheel high current",
    [ALERT_TYPE.RIGHT_WHEEL_CURRENT_LARGE_CURRENT_WARNING]: "Right wheel high current",
    [ALERT_TYPE.LEFT_BUMP_REPEAT_TRIGE_WARNING]: "Left bumper repeated trigger",
    [ALERT_TYPE.RIGHT_BUMP_REPEAT_TRIGE_WARNING]: "Right bumper repeated trigger",
    [ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_WARNING]: "Bumper stuck (warning)",
    [ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_ERROR]: "Bumper stuck",
    [ALERT_TYPE.BUMP_LONG_TIMER_NO_TRIGE_ERROR]: "Bumper not responding",
    [ALERT_TYPE.DEGREE_NO_CHANGE_WARNING]: "Heading unchanged (warning)",
    [ALERT_TYPE.DEGREE_NO_CHANGE_ERROR]: "Heading unchanged",
    [ALERT_TYPE.LEFT_WHEEL_SPEED_ERROR]: "Left wheel speed error",
    [ALERT_TYPE.RIGHT_WHEEL_SPEED_ERROR]: "Right wheel speed error",
    [ALERT_TYPE.FAN_SPEED_ERROR]: "Fan speed error",
    [ALERT_TYPE.POSE_NO_CHANGE_WARNING]: "Robot not moving",
    [ALERT_TYPE.ROLL_GESTURE_SLOPE_WARNING]: "Robot tilted sideways",
    [ALERT_TYPE.PITCH_GESTURE_SLOPE_WARNING]: "Robot tilted forward/backward",
    [ALERT_TYPE.ROBOT_BEEN_MOVED_DURING_IDLE]: "Robot moved while idle",
    [ALERT_TYPE.NO_RETURN_CHARGE_WARNING]: "Cannot find charging station",
    [ALERT_TYPE.FAN_SPEED_STATE_CHANGED_WARNING]: "Fan speed changed unexpectedly",
    [ALERT_TYPE.ROBOT_STUCK_ERROR]: "Robot stuck",
    [ALERT_TYPE.LDS_ERROR]: "LDS (laser) sensor error",
    [ALERT_TYPE.ULTRA_WATERBOX_WARNING]: "Water tank warning",
    [ALERT_TYPE.ULTRA_WATERBOX_ERROR]: "Water tank error",
};

/**
 * Maps alert type IDs to ValetudoRobotError subsystems.
 * @type {Object<number, string>}
 */
const ALERT_SUBSYSTEM_MAP = {
    [ALERT_TYPE.DIRT_BOX_STATE]: ValetudoRobotError.SUBSYSTEM.ATTACHMENTS,
    [ALERT_TYPE.WATER_BOX_STATE]: ValetudoRobotError.SUBSYSTEM.ATTACHMENTS,
    [ALERT_TYPE.FALL_ERROR]: ValetudoRobotError.SUBSYSTEM.SENSORS,
    [ALERT_TYPE.BRUSH_CURRENT_STATE_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.SIDE_BRUSH_CURRENT_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.LEFT_WHEEL_CURRENT_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.RIGHT_WHEEL_CURRENT_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.DOWNIN_ERROR]: ValetudoRobotError.SUBSYSTEM.SENSORS,
    [ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_ERROR]: ValetudoRobotError.SUBSYSTEM.SENSORS,
    [ALERT_TYPE.BUMP_LONG_TIMER_NO_TRIGE_ERROR]: ValetudoRobotError.SUBSYSTEM.SENSORS,
    [ALERT_TYPE.DEGREE_NO_CHANGE_ERROR]: ValetudoRobotError.SUBSYSTEM.NAVIGATION,
    [ALERT_TYPE.LEFT_WHEEL_SPEED_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.RIGHT_WHEEL_SPEED_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.FAN_SPEED_ERROR]: ValetudoRobotError.SUBSYSTEM.MOTORS,
    [ALERT_TYPE.ROBOT_STUCK_ERROR]: ValetudoRobotError.SUBSYSTEM.NAVIGATION,
    [ALERT_TYPE.LDS_ERROR]: ValetudoRobotError.SUBSYSTEM.SENSORS,
    [ALERT_TYPE.ULTRA_WATERBOX_ERROR]: ValetudoRobotError.SUBSYSTEM.ATTACHMENTS,
};

/**
 * @param {number} alertType
 * @returns {string}
 */
function alertTypeName(alertType) {
    return ALERT_TYPE_NAMES[alertType] ?? `Unknown alert (${alertType})`;
}

/**
 * Find the most severe error-level alert from a list of triggered alerts.
 * Returns the first error-level alert, or null if none are errors.
 *
 * @param {Array<{type: number, state: number}>} triggeredAlerts
 * @returns {{type: number, state: number}|null}
 */
function findMostSevereErrorAlert(triggeredAlerts) {
    for (const alert of triggeredAlerts) {
        if (ERROR_ALERT_TYPES.has(alert.type)) {
            return alert;
        }
    }
    return null;
}

/**
 * Map an alert type ID to a ValetudoRobotError.
 *
 * @param {number} alertType
 * @returns {ValetudoRobotError}
 */
function mapAlertToRobotError(alertType) {
    return new ValetudoRobotError({
        severity: {
            kind: ValetudoRobotError.SEVERITY_KIND.TRANSIENT,
            level: ValetudoRobotError.SEVERITY_LEVEL.ERROR,
        },
        subsystem: ALERT_SUBSYSTEM_MAP[alertType] ?? ValetudoRobotError.SUBSYSTEM.UNKNOWN,
        message: alertTypeName(alertType),
        vendorErrorCode: String(alertType)
    });
}

module.exports = {
    alertTypeName: alertTypeName,
    findMostSevereErrorAlert: findMostSevereErrorAlert,
    mapAlertToRobotError: mapAlertToRobotError,
};
