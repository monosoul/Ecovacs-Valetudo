const ValetudoRobotError = require("../../entities/core/ValetudoRobotError");
const {ALERT_TYPE} = require("./ros/core/TopicStateSubscriber");

/**
 * Severity of an alert as classified by us (not by the robot firmware, which
 * only tags alerts as "warning" or "error" in its own naming and doesn't
 * necessarily agree with what should actually be terminal to Valetudo).
 *
 * Only ERROR-severity alerts cause the robot state to transition to
 * StatusStateAttribute.VALUE.ERROR. Everything else is surfaced as a log
 * entry only, since it doesn't warrant interrupting an active job.
 *
 * @typedef {string} EcovacsAlertSeverity
 * @enum {string}
 */
const ALERT_SEVERITY = Object.freeze({
    ERROR: "error",
    WARNING: "warning",
    INFO: "info"
});

const SUBSYSTEM = ValetudoRobotError.SUBSYSTEM;
const SEVERITY_KIND = ValetudoRobotError.SEVERITY_KIND;

/**
 * Single source of truth for alert type metadata: human name, our own
 * severity classification (which alerts are actually terminal to a job vs.
 * merely worth logging), the affected ValetudoRobotError subsystem, and
 * whether the underlying issue is expected to be transient (e.g. resolves
 * itself once the robot is freed) or permanent (e.g. broken hardware).
 *
 * Kept as one table (rather than separate name/severity/subsystem maps) so
 * these properties can't drift apart, and so every ALERT_TYPE is guaranteed
 * to have a definition (enforced at module load, see below).
 *
 * @type {Object<number, {name: string, severity: EcovacsAlertSeverity, subsystem: string, kind: string}>}
 */
const ALERT_DEFINITIONS = Object.freeze({
    [ALERT_TYPE.DIRT_BOX_STATE]: {
        name: "Dustbin issue", severity: ALERT_SEVERITY.INFO, subsystem: SUBSYSTEM.ATTACHMENTS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.WATER_BOX_STATE]: {
        name: "Water tank issue", severity: ALERT_SEVERITY.INFO, subsystem: SUBSYSTEM.ATTACHMENTS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.FALL_ERROR]: {
        name: "Cliff sensor error", severity: ALERT_SEVERITY.ERROR, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.BRUSH_CURRENT_STATE_ERROR]: {
        name: "Main brush overcurrent", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.SIDE_BRUSH_CURRENT_ERROR]: {
        name: "Side brush overcurrent", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LEFT_WHEEL_CURRENT_ERROR]: {
        name: "Left wheel overcurrent", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.RIGHT_WHEEL_CURRENT_ERROR]: {
        name: "Right wheel overcurrent", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.DOWNIN_ERROR]: {
        name: "Drop sensor error", severity: ALERT_SEVERITY.ERROR, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.BRUSH_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Main brush high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Side brush high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LEFT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Left side brush high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.RIGHT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Right side brush high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.FALL_STATE_WARNING]: {
        name: "Cliff sensor warning", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LEFT_WHEEL_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Left wheel high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.RIGHT_WHEEL_CURRENT_LARGE_CURRENT_WARNING]: {
        name: "Right wheel high current", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LEFT_BUMP_REPEAT_TRIGE_WARNING]: {
        name: "Left bumper repeated trigger", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.RIGHT_BUMP_REPEAT_TRIGE_WARNING]: {
        name: "Right bumper repeated trigger", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_WARNING]: {
        name: "Bumper stuck (warning)", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_ERROR]: {
        name: "Bumper stuck", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.BUMP_LONG_TIMER_NO_TRIGE_ERROR]: {
        name: "Bumper not responding", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.DEGREE_NO_CHANGE_WARNING]: {
        name: "Heading unchanged (warning)", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.NAVIGATION, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.DEGREE_NO_CHANGE_ERROR]: {
        name: "Heading unchanged", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.NAVIGATION, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LEFT_WHEEL_SPEED_ERROR]: {
        name: "Left wheel speed error", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.RIGHT_WHEEL_SPEED_ERROR]: {
        name: "Right wheel speed error", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.FAN_SPEED_ERROR]: {
        name: "Fan speed error", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.POSE_NO_CHANGE_WARNING]: {
        name: "Robot not moving", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.NAVIGATION, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.ROLL_GESTURE_SLOPE_WARNING]: {
        name: "Robot tilted sideways", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.PITCH_GESTURE_SLOPE_WARNING]: {
        name: "Robot tilted forward/backward", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.ROBOT_BEEN_MOVED_DURING_IDLE]: {
        name: "Robot moved while idle", severity: ALERT_SEVERITY.INFO, subsystem: SUBSYSTEM.NAVIGATION, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.NO_RETURN_CHARGE_WARNING]: {
        name: "Cannot find charging station", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.DOCK, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.FAN_SPEED_STATE_CHANGED_WARNING]: {
        name: "Fan speed changed unexpectedly", severity: ALERT_SEVERITY.INFO, subsystem: SUBSYSTEM.MOTORS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.ROBOT_STUCK_ERROR]: {
        name: "Robot stuck", severity: ALERT_SEVERITY.ERROR, subsystem: SUBSYSTEM.NAVIGATION, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.LDS_ERROR]: {
        name: "LDS (laser) sensor error", severity: ALERT_SEVERITY.ERROR, subsystem: SUBSYSTEM.SENSORS, kind: SEVERITY_KIND.PERMANENT
    },
    [ALERT_TYPE.ULTRA_WATERBOX_WARNING]: {
        name: "Water tank warning", severity: ALERT_SEVERITY.WARNING, subsystem: SUBSYSTEM.ATTACHMENTS, kind: SEVERITY_KIND.TRANSIENT
    },
    [ALERT_TYPE.ULTRA_WATERBOX_ERROR]: {
        name: "Water tank error", severity: ALERT_SEVERITY.ERROR, subsystem: SUBSYSTEM.ATTACHMENTS, kind: SEVERITY_KIND.PERMANENT
    }
});

// Every ALERT_TYPE must have a definition above. This is cheap drift
// protection: without it, a newly-added alert type would silently fall
// through as an "Unknown alert" with UNKNOWN severity/subsystem instead of
// failing loudly during development.
for (const alertTypeId of Object.values(ALERT_TYPE)) {
    if (ALERT_DEFINITIONS[alertTypeId] === undefined) {
        throw new Error(`EcovacsAlertMapping: missing ALERT_DEFINITIONS entry for alert type ${alertTypeId}`);
    }
}

/**
 * Priority order (highest first) used by findMostSevereErrorAlert to pick a
 * single alert to report when multiple error-severity alerts are triggered
 * at once, so the reported error doesn't flip-flop based on array order.
 *
 * @type {Array<number>}
 */
const ERROR_ALERT_PRIORITY = [
    ALERT_TYPE.ROBOT_STUCK_ERROR,
    ALERT_TYPE.FALL_ERROR,
    ALERT_TYPE.DOWNIN_ERROR,
    ALERT_TYPE.LDS_ERROR,
    ALERT_TYPE.ULTRA_WATERBOX_ERROR
];

/**
 * @param {number} alertType
 * @returns {{name: string, severity: EcovacsAlertSeverity, subsystem: string, kind: string}}
 */
function alertDefinition(alertType) {
    return ALERT_DEFINITIONS[alertType] ?? {
        name: `Unknown alert (${alertType})`,
        severity: ALERT_SEVERITY.WARNING,
        subsystem: SUBSYSTEM.UNKNOWN,
        kind: SEVERITY_KIND.UNKNOWN
    };
}

/**
 * @param {number} alertType
 * @returns {string}
 */
function alertTypeName(alertType) {
    return alertDefinition(alertType).name;
}

/**
 * @param {number} alertType
 * @returns {EcovacsAlertSeverity}
 */
function alertSeverity(alertType) {
    return alertDefinition(alertType).severity;
}

/**
 * Find the most severe error-level alert from a list of triggered alerts.
 * Returns the highest-priority error-level alert (see ERROR_ALERT_PRIORITY),
 * or null if none of the triggered alerts are error-severity.
 *
 * @param {Array<{type: number, state: number}>} triggeredAlerts
 * @returns {{type: number, state: number}|null}
 */
function findMostSevereErrorAlert(triggeredAlerts) {
    const errorAlerts = triggeredAlerts.filter(alert => {
        return alertSeverity(alert.type) === ALERT_SEVERITY.ERROR;
    });

    if (errorAlerts.length === 0) {
        return null;
    }

    for (const priorityType of ERROR_ALERT_PRIORITY) {
        const match = errorAlerts.find(alert => {
            return alert.type === priorityType;
        });
        if (match) {
            return match;
        }
    }

    // Error-severity alert not covered by the priority list (e.g. newly added). Report it anyway.
    return errorAlerts[0];
}

/**
 * Map an alert type ID to a ValetudoRobotError.
 *
 * @param {number} alertType
 * @returns {ValetudoRobotError}
 */
function mapAlertToRobotError(alertType) {
    const definition = alertDefinition(alertType);
    const severityLevel = definition.severity === ALERT_SEVERITY.ERROR ?
        ValetudoRobotError.SEVERITY_LEVEL.ERROR :
        ValetudoRobotError.SEVERITY_LEVEL.WARNING;

    return new ValetudoRobotError({
        severity: {
            kind: definition.kind,
            level: severityLevel
        },
        subsystem: definition.subsystem,
        message: definition.name,
        vendorErrorCode: String(alertType)
    });
}

module.exports = {
    ALERT_SEVERITY: ALERT_SEVERITY,
    alertDefinition: alertDefinition,
    alertSeverity: alertSeverity,
    alertTypeName: alertTypeName,
    findMostSevereErrorAlert: findMostSevereErrorAlert,
    mapAlertToRobotError: mapAlertToRobotError,
};
