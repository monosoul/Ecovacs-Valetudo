"use strict";

const http = require("http");
const https = require("https");
const Logger = require("../../../../Logger");
const {URL} = require("url");

class RosMasterXmlRpcClient {
    /**
     * @param {object} options
     * @param {string} options.masterUri
     * @param {number} [options.timeoutMs]
     */
    constructor(options) {
        this.masterUri = normalizeLocalhostUri(options.masterUri);
        this.timeoutMs = options.timeoutMs ?? 4000;
    }

    /**
     * @param {string} callerId
     * @param {string} serviceName
     * @returns {Promise<{host:string, port:number}|null>}
     */
    async resolveService(callerId, serviceName) {
        try {
            const response = await this.call(this.masterUri, "lookupService", [callerId, serviceName]);
            if (!Array.isArray(response) || response.length < 3 || Number(response[0]) !== 1) {
                return null;
            }
            const uri = String(response[2] ?? "");
            return parseRosRpcUri(uri);
        } catch (e) {
            Logger.debug(`ROS lookupService failed for ${serviceName}: ${e?.message ?? e}`);
            return null;
        }
    }

    /**
     * @param {string} callerId
     * @param {string} topic
     * @param {string} topicType
     * @returns {Promise<{host:string,port:number}|null>}
     */
    async resolveTopicTcpEndpoint(callerId, topic, topicType) {
        // Match the Python flow used on-device:
        // getSystemState -> topic publishers -> lookupNode -> requestTopic(TCPROS)
        const publishers = await this.getTopicPublishers(callerId, topic);
        if (publishers.length === 0) {
            // Fallback to registerSubscriber when system state has no publishers yet.
            const registerResult = await this.call(this.masterUri, "registerSubscriber", [
                callerId,
                topic,
                topicType,
                "http://127.0.0.1:1"
            ]);
            if (!Array.isArray(registerResult) || registerResult.length < 3 || Number(registerResult[0]) !== 1) {
                return null;
            }
            const fromRegister = Array.isArray(registerResult[2]) ? registerResult[2] : [];
            if (fromRegister.length === 0) {
                return null;
            }

            return await this.resolveTopicFromPublishers(callerId, topic, fromRegister);
        }

        return await this.resolveTopicFromPublishers(callerId, topic, publishers);
    }

    /**
     * Resolve a topic TCP endpoint using only getSystemState + lookupNode +
     * requestTopic.  Unlike resolveTopicTcpEndpoint this never calls
     * registerSubscriber, which can crash some firmware nodes (e.g. medusa)
     * via an unexpected publisherUpdate callback.
     *
     * Returns null when the topic has no publishers (e.g. robot is idle).
     *
     * @param {string} callerId
     * @param {string} topic
     * @returns {Promise<{host:string,port:number}|null>}
     */
    async resolveTopicTcpEndpointSafe(callerId, topic) {
        const publishers = await this.getTopicPublishers(callerId, topic);
        if (publishers.length === 0) {
            return null;
        }

        return await this.resolveTopicFromPublishers(callerId, topic, publishers);
    }

    /**
     * @param {string} callerId
     * @param {string} topic
     * @returns {Promise<Array<string>>}
     */
    async getTopicPublishers(callerId, topic) {
        const systemState = await this.call(this.masterUri, "getSystemState", [callerId]);
        if (!Array.isArray(systemState) || systemState.length < 3 || Number(systemState[0]) !== 1) {
            return [];
        }
        const state = systemState[2];
        if (!Array.isArray(state) || state.length < 1 || !Array.isArray(state[0])) {
            return [];
        }
        const publishers = state[0];
        /** @type {Array<string>} */
        const out = [];
        for (const item of publishers) {
            if (!Array.isArray(item) || item.length < 2) {
                continue;
            }
            if (String(item[0]) !== topic || !Array.isArray(item[1])) {
                continue;
            }
            for (const publisher of item[1]) {
                out.push(String(publisher));
            }
        }

        return out;
    }

    /**
     * @param {string} callerId
     * @param {string} topic
     * @param {Array<string>} publishers
     * @returns {Promise<{host:string,port:number}|null>}
     */
    async resolveTopicFromPublishers(callerId, topic, publishers) {
        for (const publisherName of publishers) {
            const lookupNodeResult = await this.call(this.masterUri, "lookupNode", [callerId, String(publisherName)]);
            if (!Array.isArray(lookupNodeResult) || lookupNodeResult.length < 3 || Number(lookupNodeResult[0]) !== 1) {
                continue;
            }

            const nodeUri = normalizeLocalhostUri(String(lookupNodeResult[2] ?? ""));
            if (!nodeUri) {
                continue;
            }
            const requestTopicResult = await this.call(nodeUri, "requestTopic", [
                callerId,
                topic,
                [["TCPROS"]]
            ]);
            if (!Array.isArray(requestTopicResult) || requestTopicResult.length < 3 || Number(requestTopicResult[0]) !== 1) {
                continue;
            }
            const protocolParams = requestTopicResult[2];
            if (!Array.isArray(protocolParams) || protocolParams.length < 3 || String(protocolParams[0]) !== "TCPROS") {
                continue;
            }

            return {
                host: normalizeRosHost(String(protocolParams[1])),
                port: Number(protocolParams[2])
            };
        }

        return null;
    }

    /**
     * @param {string} uri
     * @param {string} methodName
     * @param {Array<any>} params
     * @returns {Promise<any>}
     */
    async call(uri, methodName, params) {
        const body = buildXmlRpcRequest(methodName, params);
        const url = new URL(uri);
        const transport = url.protocol === "https:" ? https : http;

        return await new Promise((resolve, reject) => {
            const req = transport.request({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname && url.pathname.length > 0 ? url.pathname : "/",
                method: "POST",
                headers: {
                    "Content-Type": "text/xml",
                    "Content-Length": Buffer.byteLength(body, "utf8")
                },
                timeout: this.timeoutMs
            }, res => {
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => {
                    const responseBody = Buffer.concat(chunks).toString("utf8");
                    try {
                        const parsed = parseXmlRpcMethodResponse(responseBody);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Failed to parse XML-RPC response for ${methodName}: ${e.message}`));
                    }
                });
            });

            req.on("timeout", () => {
                req.destroy(new Error(`XML-RPC timeout after ${this.timeoutMs}ms: ${methodName}`));
            });
            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }
}

/**
 * ROS nodes typically bind IPv4 only.  Node.js may resolve "localhost"
 * to ::1 (IPv6) first, causing connection timeouts when the peer has
 * no IPv6 listener.  Normalise to the IPv4 loopback address.
 *
 * @param {string} host
 * @returns {string}
 */
function normalizeRosHost(host) {
    return host === "localhost" ? "127.0.0.1" : host;
}

/**
 * Replace "localhost" with "127.0.0.1" in an HTTP URI so that
 * Node.js connects over IPv4.
 *
 * @param {string} uri
 * @returns {string}
 */
function normalizeLocalhostUri(uri) {
    return uri.replace("://localhost", "://127.0.0.1");
}

/**
 * @param {string} uri
 * @returns {{host:string,port:number}|null}
 */
function parseRosRpcUri(uri) {
    if (!uri.startsWith("rosrpc://")) {
        return null;
    }
    const raw = uri.slice("rosrpc://".length);
    const separator = raw.lastIndexOf(":");
    if (separator <= 0) {
        return null;
    }

    return {
        host: normalizeRosHost(raw.slice(0, separator)),
        port: Number(raw.slice(separator + 1))
    };
}

/**
 * @param {string} methodName
 * @param {Array<any>} params
 * @returns {string}
 */
function buildXmlRpcRequest(methodName, params) {
    const paramXml = params.map(param => `<param><value>${toXmlRpcValue(param)}</value></param>`).join("");

    return `<?xml version="1.0"?>
<methodCall>
<methodName>${escapeXml(methodName)}</methodName>
<params>${paramXml}</params>
</methodCall>`;
}

/**
 * @param {string} xml
 * @returns {any}
 */
function parseXmlRpcMethodResponse(xml) {
    const tree = parseSimpleXml(xml);
    const methodResponse = firstChildByName(tree, "methodResponse");
    if (!methodResponse) {
        throw new Error("methodResponse node not found");
    }
    const faultNode = firstChildByName(methodResponse, "fault");
    if (faultNode) {
        const valueNode = firstChildByName(faultNode, "value");
        const parsedFault = valueNode ? parseXmlRpcValueNode(valueNode) : "unknown fault";
        throw new Error(`XML-RPC fault: ${JSON.stringify(parsedFault)}`);
    }

    const paramsNode = firstChildByName(methodResponse, "params");
    const paramNode = paramsNode ? firstChildByName(paramsNode, "param") : null;
    const valueNode = paramNode ? firstChildByName(paramNode, "value") : null;
    if (!valueNode) {
        throw new Error("methodResponse.params.param.value node not found");
    }

    return parseXmlRpcValueNode(valueNode);
}

/**
 * Tiny XML parser for XML-RPC responses.
 *
 * @param {string} xml
 * @returns {{name:string,children:Array<any>,text:string}}
 */
function parseSimpleXml(xml) {
    const root = {name: "__root__", children: [], text: ""};
    const stack = [root];
    const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];

    for (const token of tokens) {
        if (token.startsWith("<?") || token.startsWith("<!")) {
            continue;
        }
        if (token.startsWith("</")) {
            stack.pop();
            continue;
        }
        if (token.startsWith("<")) {
            const rawName = token.slice(1, -1).trim();
            const selfClosing = rawName.endsWith("/");
            const name = rawName.replace(/\/$/, "").split(/\s+/)[0];
            const node = {name: name, children: [], text: ""};
            stack[stack.length - 1].children.push(node);
            if (!selfClosing) {
                stack.push(node);
            }
            continue;
        }

        const text = token.trim();
        if (text.length > 0) {
            stack[stack.length - 1].text += decodeXmlEntities(text);
        }
    }

    return root;
}

/**
 * @param {{children:Array<any>}} node
 * @param {string} name
 * @returns {any|null}
 */
function firstChildByName(node, name) {
    return node.children.find(child => child.name === name) ?? null;
}

/**
 * @param {any} valueNode
 * @returns {any}
 */
function parseXmlRpcValueNode(valueNode) {
    if (!valueNode.children || valueNode.children.length === 0) {
        return valueNode.text ?? "";
    }
    const typeNode = valueNode.children[0];
    switch (typeNode.name) {
        case "int":
        case "i4":
            return Number(typeNode.text ?? 0);
        case "boolean":
            return String(typeNode.text ?? "0") === "1";
        case "double":
            return Number(typeNode.text ?? 0);
        case "string":
            return typeNode.text ?? "";
        case "array": {
            const dataNode = firstChildByName(typeNode, "data");
            if (!dataNode) {
                return [];
            }
            return dataNode.children
                .filter(child => child.name === "value")
                .map(child => parseXmlRpcValueNode(child));
        }
        case "struct": {
            const members = typeNode.children.filter(child => child.name === "member");
            /** @type {Object<string, any>} */
            const out = {};
            for (const member of members) {
                const nameNode = firstChildByName(member, "name");
                const memberValueNode = firstChildByName(member, "value");
                if (!nameNode || !memberValueNode) {
                    continue;
                }
                out[nameNode.text ?? ""] = parseXmlRpcValueNode(memberValueNode);
            }
            return out;
        }
        default:
            return typeNode.text ?? "";
    }
}

/**
 * @param {any} value
 * @returns {string}
 */
function toXmlRpcValue(value) {
    if (Array.isArray(value)) {
        const children = value.map(child => `<value>${toXmlRpcValue(child)}</value>`).join("");

        return `<array><data>${children}</data></array>`;
    }
    if (value && typeof value === "object") {
        const members = Object.entries(value).map(([key, v]) => {
            return `<member><name>${escapeXml(key)}</name><value>${toXmlRpcValue(v)}</value></member>`;
        }).join("");

        return `<struct>${members}</struct>`;
    }
    if (typeof value === "number") {
        if (Number.isInteger(value)) {
            return `<int>${value}</int>`;
        }

        return `<double>${value}</double>`;
    }
    if (typeof value === "boolean") {
        return `<boolean>${value ? 1 : 0}</boolean>`;
    }

    return `<string>${escapeXml(String(value ?? ""))}</string>`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

module.exports = RosMasterXmlRpcClient;
