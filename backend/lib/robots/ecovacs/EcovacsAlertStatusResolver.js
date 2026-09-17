const entities = require("../../entities");
const {ALERT_SEVERITY, alertDefinition, findMostSevereErrorAlert, mapAlertToRobotError} = require("./EcovacsAlertMapping");
const {WORK_STATE, determineRobotStatus} = require("./EcovacsStateMapping");

const stateAttrs = entities.state.attributes;

/**
 * Turns the robot's raw workState/chargeState/triggeredAlerts into the
 * StatusStateAttribute Valetudo should report, without ever letting a
 * non-fatal alert (e.g. "heading unchanged") destroy an active job.
 *
 * Rules:
 *  - While the robot itself reports that it is running (cleaning/returning/
 *    moving/manual_control), an error-severity alert never overrides that
 *    status. This is what keeps the Pause button available. The alert is
 *    instead surfaced once as a dismissible event (see eventMessages).
 *  - Once the robot has actually stopped (paused or idle) with an
 *    error-severity alert still active, status becomes ERROR with the
 *    RESUMABLE flag, so Start becomes "Resume" and continues the same job
 *    instead of starting a fresh one.
 *  - Warning/info-severity alerts never affect status; they are only logged.
 *
 * All alert bookkeeping (which alerts are new/gone since the last poll) is
 * edge-triggered and kept here so it can be unit tested without any ROS
 * plumbing.
 */
class EcovacsAlertStatusResolver {
    constructor() {
        /** @type {Set<number>} */
        this.previousAlertTypes = new Set();
    }

    /**
     * @param {object} params
     * @param {Array<{type: number, state: number}>|null} params.triggeredAlerts - null means "no observation this poll" (e.g. topic not yet received), as opposed to an empty array which means "observed: nothing triggered".
     * @param {{worktype: number, state: number, workcause: number}|null|undefined} params.workState
     * @param {{isOnCharger: number, chargeState: number}|null|undefined} params.chargeState
     * @returns {{
     *   statusValue: string,
     *   statusFlag: string,
     *   error: (import("../../entities/core/ValetudoRobotError")|null),
     *   logEntries: Array<{level: "warn"|"info"|"debug", message: string}>,
     *   eventMessages: Array<string>
     * }}
     */
    resolve(params) {
        const {triggeredAlerts, workState, chargeState} = params;
        /** @type {Array<{level: "warn"|"info"|"debug", message: string}>} */
        const logEntries = [];
        /** @type {Array<string>} */
        const eventMessages = [];

        // `triggeredAlerts` is null when there's no observation to make this poll
        // (e.g. the /alert/Alerts topic hasn't delivered a message yet). That must
        // NOT be treated as "every alert cleared" - only a decoded array, even an
        // empty one, is a real observation worth diffing against.
        const currentAlertTypes = Array.isArray(triggeredAlerts) ?
            new Set(triggeredAlerts.map(alert => alert.type)) :
            null;

        if (currentAlertTypes !== null) {
            for (const type of currentAlertTypes) {
                if (!this.previousAlertTypes.has(type)) {
                    const definition = alertDefinition(type);

                    logEntries.push({
                        level: definition.severity === ALERT_SEVERITY.INFO ? "debug" : "warn",
                        message: `Ecovacs alert raised: ${definition.name} (type=${type}, severity=${definition.severity})`
                    });

                    if (definition.severity === ALERT_SEVERITY.ERROR && workState?.state === WORK_STATE.RUNNING) {
                        // The firmware hasn't stopped the job over this, so don't touch status
                        // (see below) - just make sure the user finds out about it.
                        eventMessages.push(`${definition.name} — job still active`);
                    }
                }
            }

            for (const type of this.previousAlertTypes) {
                if (!currentAlertTypes.has(type)) {
                    logEntries.push({
                        level: "info",
                        message: `Ecovacs alert cleared: ${alertDefinition(type).name} (type=${type})`
                    });
                }
            }

            this.previousAlertTypes = currentAlertTypes;
        }

        const errorAlert = triggeredAlerts && triggeredAlerts.length > 0 ?
            findMostSevereErrorAlert(triggeredAlerts) :
            null;

        const statusValueBase = determineRobotStatus(workState, chargeState);

        let statusValue = statusValueBase;
        let statusFlag = stateAttrs.StatusStateAttribute.FLAG.NONE;
        let error = null;

        if (statusValueBase === stateAttrs.StatusStateAttribute.VALUE.DOCKED) {
            // Nothing to do - docked wins over everything.
        } else if (new stateAttrs.StatusStateAttribute({value: statusValueBase}).isActiveState) {
            // Robot is actively running (cleaning/returning/moving/manual_control).
            // Never let an error alert override this - that's exactly what disables
            // Pause and abandons the job. The alert was already surfaced above.
        } else if (statusValueBase === stateAttrs.StatusStateAttribute.VALUE.PAUSED) {
            statusFlag = stateAttrs.StatusStateAttribute.FLAG.RESUMABLE;

            if (errorAlert) {
                statusValue = stateAttrs.StatusStateAttribute.VALUE.ERROR;
                error = mapAlertToRobotError(errorAlert.type);
            }
        } else if (errorAlert) {
            // IDLE (or an otherwise unrecognized workState) with an active error alert.
            statusValue = stateAttrs.StatusStateAttribute.VALUE.ERROR;
            error = mapAlertToRobotError(errorAlert.type);
        }

        return {
            statusValue: statusValue,
            statusFlag: statusFlag,
            error: error,
            logEntries: logEntries,
            eventMessages: eventMessages
        };
    }
}

module.exports = EcovacsAlertStatusResolver;
